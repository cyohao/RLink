// 路由匹配、参数校验、条件场景判断，对应 Node 版的 src/engine.js

use serde_json::Value;

use crate::js::{as_text, is_blank, js_string, to_number, utf16_len, Obj};
use crate::store::{Condition, Mock, Rule, Scenario};
use crate::template::{render_string, resolve_in_ctx, resolve_path, TemplateError};

fn decode(seg: &str) -> String {
    percent_encoding::percent_decode_str(seg).decode_utf8().map(|s| s.into_owned()).unwrap_or_else(|_| seg.to_string())
}

fn split(p: &str) -> Vec<&str> {
    p.split('/').filter(|x| !x.is_empty()).collect()
}

/// 返回 (路径参数, 得分) 或 None。静态段得分高于 :参数，参数高于 *，用于多条接口都能匹配时选最具体的
pub fn match_path(pattern: &str, pathname: &str) -> Option<(Obj, i64)> {
    let ps = split(pattern);
    let xs: Vec<String> = split(pathname).into_iter().map(decode).collect();
    let mut params = Obj::new();
    let mut score = 0;
    for (i, seg) in ps.iter().enumerate() {
        if *seg == "*" {
            params.insert("*".into(), Value::String(xs.get(i..).map(|r| r.join("/")).unwrap_or_default()));
            return Some((params, score + 1));
        }
        if i >= xs.len() {
            return None;
        }
        if let Some(name) = seg.strip_prefix(':') {
            params.insert(name.into(), Value::String(xs[i].clone()));
            score += 2;
        } else if decode(seg) == xs[i] {
            score += 3;
        } else {
            return None;
        }
    }
    if xs.len() == ps.len() {
        Some((params, score))
    } else {
        None
    }
}

pub fn find_mock<'a>(mocks: &'a [Mock], method: &str, pathname: &str) -> Option<(&'a Mock, Obj)> {
    let mut best: Option<(&Mock, Obj, i64)> = None;
    for mock in mocks {
        if !mock.enabled || (mock.method != "ANY" && mock.method != method) {
            continue;
        }
        let Some((params, score)) = match_path(&mock.path, pathname) else {
            continue;
        };
        let score = score * 10 + if mock.method == "ANY" { 0 } else { 5 };
        if best.as_ref().map_or(true, |b| score > b.2) {
            best = Some((mock, params, score));
        }
    }
    best.map(|(m, p, _)| (m, p))
}

fn type_label(t: &str) -> &'static str {
    match t {
        "string" => "字符串",
        "number" => "数字",
        "integer" => "整数",
        "boolean" => "布尔值",
        "array" => "数组",
        "object" => "对象",
        _ => "",
    }
}

fn is_num_str(s: &str, allow_frac: bool) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    let mut it = t.splitn(2, '.');
    let int = it.next().unwrap_or("");
    let frac = it.next();
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match frac {
        None => true,
        Some(f) => allow_frac && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()),
    }
}

// strict=false 时允许字符串形式的数字/布尔（query、header、表单提交的值都是字符串）
fn check_type(v: &Value, t: &str, strict: bool) -> bool {
    match t {
        "string" => v.is_string(),
        "number" => match v {
            Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            Value::String(s) => !strict && is_num_str(s, true),
            _ => false,
        },
        "integer" => match v {
            Value::Number(n) => n.as_f64().is_some_and(|f| f.is_finite() && f == f.trunc()),
            Value::String(s) => !strict && is_num_str(s, false),
            _ => false,
        },
        "boolean" => v.is_boolean() || (!strict && matches!(v.as_str(), Some("true") | Some("false"))),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    }
}

pub fn validate_rules(rules: &[Rule], ctx: &Obj, body_is_json: bool) -> Vec<String> {
    let mut errors = Vec::new();
    for rule in rules {
        let key = if rule.source == "headers" { rule.name.to_lowercase() } else { rule.name.clone() };
        let value = resolve_path(ctx.get(&rule.source), &key);
        if is_blank(value.as_ref()) {
            if rule.required {
                errors.push(format!("{} 不能为空", rule.name));
            }
            continue;
        }
        let value = value.unwrap();
        let strict = rule.source == "body" && body_is_json;
        if rule.kind != "any" && !check_type(&value, &rule.kind, strict) {
            errors.push(format!("{} 应为{}", rule.name, type_label(&rule.kind)));
            continue;
        }
        let primitive = !(value.is_object() || value.is_array() || value.is_null());
        let text = js_string(Some(&value));
        if primitive && rule.max_length > 0 && utf16_len(&text) as i64 > rule.max_length {
            errors.push(format!("{} 长度不能超过 {}", rule.name, rule.max_length));
        }
        if primitive && !rule.options.is_empty() && !rule.options.contains(&text) {
            errors.push(format!("{} 只能是 {}", rule.name, rule.options.join(" / ")));
        }
    }
    errors
}

fn test_condition(cond: &Condition, ctx: &Obj) -> Result<bool, TemplateError> {
    // header 名在请求里统一是小写
    let field = if cond.field.len() > 8 && cond.field.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("headers.")) {
        format!("headers.{}", cond.field[8..].to_lowercase())
    } else {
        cond.field.clone()
    };
    let actual = resolve_in_ctx(ctx, &field);
    match cond.op.as_str() {
        "exists" => return Ok(!is_blank(actual.as_ref())),
        "notExists" => return Ok(is_blank(actual.as_ref())),
        _ => {}
    }
    let expected = render_string(&cond.value, ctx)?;
    let a = to_number(actual.as_ref());
    let b = to_number(expected.as_ref());
    let numeric = !is_blank(actual.as_ref()) && !is_blank(expected.as_ref()) && !a.is_nan() && !b.is_nan();
    let at = as_text(actual.as_ref());
    let et = as_text(expected.as_ref());
    Ok(match cond.op.as_str() {
        "eq" => at == et,
        "ne" => at != et,
        "gt" => numeric && a > b,
        "gte" => numeric && a >= b,
        "lt" => numeric && a < b,
        "lte" => numeric && a <= b,
        "contains" => match &actual {
            Some(Value::Array(list)) => list.iter().any(|x| as_text(Some(x)) == et),
            _ => at.contains(&et),
        },
        _ => false,
    })
}

// 没有条件的场景视为「强制返回」：启用后所有请求都命中
pub fn match_scenario(sc: &Scenario, ctx: &Obj) -> Result<bool, TemplateError> {
    if !sc.enabled {
        return Ok(false);
    }
    if sc.conditions.is_empty() {
        return Ok(true);
    }
    for c in &sc.conditions {
        let hit = test_condition(c, ctx)?;
        if sc.match_mode == "any" && hit {
            return Ok(true);
        }
        if sc.match_mode != "any" && !hit {
            return Ok(false);
        }
    }
    Ok(sc.match_mode != "any")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matching() {
        assert_eq!(match_path("/box/:id", "/box/B01").unwrap().0["id"], "B01");
        assert!(match_path("/box/:id", "/box/B01/x").is_none());
        assert_eq!(match_path("/files/*", "/files/a/b").unwrap().0["*"], "a/b");
        assert!(match_path("/box/list", "/box/list").unwrap().1 > match_path("/box/:id", "/box/list").unwrap().1);
        assert_eq!(match_path("/a/:x", "/a/%E4%B8%AD").unwrap().0["x"], "中");
    }
}
