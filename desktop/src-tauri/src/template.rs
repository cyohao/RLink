// 返回值模板引擎，对应 Node 版的 src/template.js。
// 表达式只支持「取值路径」和「内置函数调用」，不执行任意代码。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use rand::Rng;
use serde_json::Value;

use crate::js::{as_text, fmt_num, is_blank, js_string, num_value, stringify, to_number, truthy, utf16_len, Obj};

const MAX_REPEAT: f64 = 10000.0;
const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// 内置函数名，顺序和 Node 版的 Object.keys(HELPERS) 一致
pub const HELPER_NAMES: [&str; 28] = [
    "now", "timestamp", "uuid", "randomInt", "randomStr", "pick", "seq", "pad", "concat", "add", "sub", "mul", "div", "ceil", "floor", "round", "min",
    "max", "len", "upper", "lower", "default", "number", "string", "eq", "gt", "lt", "if",
];

static COUNTERS: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct TemplateError(pub String);

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

type R<T> = Result<T, TemplateError>;

fn err<T>(msg: impl Into<String>) -> R<T> {
    Err(TemplateError(msg.into()))
}

pub fn is_helper(name: &str) -> bool {
    HELPER_NAMES.contains(&name)
}

// ---------- 上下文 ----------

/// 模板上下文：base 是请求信息（body、query、params……），extra 是 $repeat 里追加的 $index 等
pub struct Ctx<'a> {
    pub base: &'a Obj,
    pub extra: Obj,
}

impl<'a> Ctx<'a> {
    pub fn new(base: &'a Obj) -> Self {
        Ctx { base, extra: Obj::new() }
    }

    fn get(&self, key: &str) -> Option<&Value> {
        if self.extra.contains_key(key) {
            return self.extra.get(key);
        }
        self.base.get(key)
    }
}

// ---------- 取值路径 ----------

/// "list[0].code" → ["list", "0", "code"]
fn split_path(path: &str) -> Vec<String> {
    let mut s = String::new();
    let chars: Vec<char> = path.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == ']') {
                let inner: String = chars[i + 1..i + 1 + end].iter().collect();
                if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    s.push('.');
                    s.push_str(&inner);
                    i += end + 2;
                    continue;
                }
            }
        }
        s.push(chars[i]);
        i += 1;
    }
    s.split('.').filter(|p| !p.is_empty()).map(String::from).collect()
}

fn step(cur: &Value, key: &str) -> Option<Value> {
    match cur {
        Value::Object(m) => m.get(key).cloned(),
        Value::Array(a) => {
            if key == "length" {
                return Some(Value::from(a.len()));
            }
            key.parse::<usize>().ok().filter(|i| i.to_string() == key).and_then(|i| a.get(i).cloned())
        }
        Value::String(s) => {
            if key == "length" {
                return Some(Value::from(utf16_len(s)));
            }
            let idx = key.parse::<usize>().ok().filter(|i| i.to_string() == key)?;
            let units: Vec<u16> = s.encode_utf16().collect();
            units.get(idx).map(|u| Value::String(String::from_utf16_lossy(&[*u])))
        }
        _ => None,
    }
}

fn walk(start: Option<Value>, parts: &[String]) -> Option<Value> {
    let mut cur = start;
    for key in parts {
        let c = cur?;
        if c.is_null() || FORBIDDEN_KEYS.contains(&key.as_str()) {
            return None;
        }
        cur = step(&c, key);
    }
    cur
}

/// 从一个值开始取路径，对应 resolvePath(obj, path)
pub fn resolve_path(obj: Option<&Value>, path: &str) -> Option<Value> {
    walk(obj.cloned(), &split_path(path))
}

fn resolve_ctx(ctx: &Ctx, path: &str) -> Option<Value> {
    let parts = split_path(path);
    let Some((first, rest)) = parts.split_first() else {
        return None;
    };
    if FORBIDDEN_KEYS.contains(&first.as_str()) {
        return None;
    }
    walk(ctx.get(first).cloned(), rest)
}

/// 在上下文上取值，供条件场景使用
pub fn resolve_in_ctx(base: &Obj, path: &str) -> Option<Value> {
    resolve_ctx(&Ctx::new(base), path)
}

// ---------- 词法、语法 ----------

#[derive(Debug, Clone)]
enum Tok {
    Open,
    Close,
    Lit(Value),
    Id(String),
}

#[derive(Debug, Clone)]
enum Node {
    Lit(Value),
    Id(String),
    Call(Vec<Node>),
}

fn tokenize(src: &str) -> R<Vec<Tok>> {
    let chars: Vec<char> = src.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '(' {
            tokens.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            tokens.push(Tok::Close);
            i += 1;
        } else if c == '\'' || c == '"' {
            let mut j = i + 1;
            let mut s = String::new();
            while j < chars.len() && chars[j] != c {
                if chars[j] == '\\' && j + 1 < chars.len() {
                    s.push(chars[j + 1]);
                    j += 2;
                } else {
                    s.push(chars[j]);
                    j += 1;
                }
            }
            if j >= chars.len() {
                return err(format!("字符串缺少结束引号: {}", src));
            }
            tokens.push(Tok::Lit(Value::String(s)));
            i = j + 1;
        } else {
            let mut j = i;
            while j < chars.len() && !(chars[j].is_whitespace() || "()'\"".contains(chars[j])) {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            i = j;
            if is_number_word(&word) {
                tokens.push(Tok::Lit(num_value(word.parse::<f64>().unwrap_or(f64::NAN))));
            } else if word == "true" || word == "false" {
                tokens.push(Tok::Lit(Value::Bool(word == "true")));
            } else if word == "null" {
                tokens.push(Tok::Lit(Value::Null));
            } else {
                tokens.push(Tok::Id(word));
            }
        }
    }
    Ok(tokens)
}

// /^-?\d+(\.\d+)?$/
fn is_number_word(w: &str) -> bool {
    let s = w.strip_prefix('-').unwrap_or(w);
    let mut parts = s.splitn(2, '.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    !int.is_empty() && int.bytes().all(|b| b.is_ascii_digit()) && frac.map_or(true, |f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

fn parse(tokens: &[Tok]) -> R<Node> {
    fn atom(tokens: &[Tok], pos: &mut usize) -> R<Node> {
        let tk = tokens[*pos].clone();
        *pos += 1;
        match tk {
            Tok::Close => err("多余的右括号"),
            Tok::Lit(v) => Ok(Node::Lit(v)),
            Tok::Id(s) => Ok(Node::Id(s)),
            Tok::Open => {
                let mut items = Vec::new();
                while *pos < tokens.len() && !matches!(tokens[*pos], Tok::Close) {
                    items.push(atom(tokens, pos)?);
                }
                if *pos >= tokens.len() {
                    return err("缺少右括号");
                }
                *pos += 1;
                Ok(Node::Call(items))
            }
        }
    }
    let mut pos = 0;
    let mut items = Vec::new();
    while pos < tokens.len() {
        items.push(atom(tokens, &mut pos)?);
    }
    Ok(Node::Call(items))
}

// ---------- 求值 ----------

fn eval_node(node: &Node, ctx: &Ctx) -> R<Option<Value>> {
    match node {
        Node::Lit(v) => Ok(Some(v.clone())),
        // 单独出现的函数名（如 concat 'A' uuid）按无参调用处理，其余按取值路径处理
        Node::Id(name) => {
            if is_helper(name) {
                call_helper(name, &[])
            } else {
                Ok(resolve_ctx(ctx, name))
            }
        }
        Node::Call(items) => {
            let Some((head, rest)) = items.split_first() else {
                return err("表达式为空");
            };
            if let Node::Id(name) = head {
                // if 只计算选中的分支，避免没选中的分支里的 seq 等函数也被执行
                if name == "if" {
                    let Some(cond) = rest.first() else {
                        return err("if 缺少条件");
                    };
                    let c = eval_node(cond, ctx)?;
                    let pass = truthy(c.as_ref()) && !matches!(&c, Some(Value::String(s)) if s == "false" || s == "0");
                    let branch = if pass { rest.get(1) } else { rest.get(2) };
                    return match branch {
                        Some(n) => eval_node(n, ctx),
                        None => Ok(Some(Value::String(String::new()))),
                    };
                }
                if is_helper(name) {
                    let args = rest.iter().map(|n| eval_node(n, ctx)).collect::<R<Vec<_>>>()?;
                    return call_helper(name, &args);
                }
            }
            if rest.is_empty() {
                return eval_node(head, ctx);
            }
            let name = match head {
                Node::Id(n) => n.clone(),
                _ => "(...)".into(),
            };
            err(format!("未知的函数: {}", name))
        }
    }
}

fn evaluate(expr: &str, ctx: &Ctx) -> R<Option<Value>> {
    let run = || -> R<Option<Value>> {
        let tokens = tokenize(expr)?;
        let node = parse(&tokens)?;
        eval_node(&node, ctx)
    };
    run().map_err(|e| TemplateError(format!("{{{{{}}}}} {}", expr.trim(), e.0)))
}

// ---------- 内置函数 ----------

fn arg(args: &[Option<Value>], i: usize) -> Option<&Value> {
    args.get(i).and_then(|a| a.as_ref())
}

fn msg_value(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => stringify(v),
    }
}

fn to_num(v: Option<&Value>, func: &str) -> R<f64> {
    let n = to_number(v);
    let bad = matches!(v, None | Some(Value::Null)) || matches!(v, Some(Value::String(s)) if s.is_empty()) || n.is_nan();
    if bad {
        return err(format!("{} 的参数不是数字: {}", func, msg_value(v)));
    }
    Ok(n)
}

fn format_date(fmt: &str) -> String {
    use chrono::{Datelike, Local, Timelike};
    let d = Local::now();
    let parts: [(&str, String); 7] = [
        ("YYYY", format!("{}", d.year())),
        ("MM", format!("{:02}", d.month())),
        ("DD", format!("{:02}", d.day())),
        ("HH", format!("{:02}", d.hour())),
        ("mm", format!("{:02}", d.minute())),
        ("SSS", format!("{:03}", d.timestamp_subsec_millis().min(999))),
        ("ss", format!("{:02}", d.second())),
    ];
    let mut out = String::new();
    let mut rest = fmt;
    'outer: while !rest.is_empty() {
        for (tok, val) in &parts {
            if rest.starts_with(tok) {
                out.push_str(val);
                rest = &rest[tok.len()..];
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn charset(name: &str) -> Option<&'static str> {
    match name {
        "digit" => Some("0123456789"),
        "upper" => Some("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        "lower" => Some("abcdefghijklmnopqrstuvwxyz"),
        "hex" => Some("0123456789abcdef"),
        "alnum" => Some("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"),
        _ => None,
    }
}

fn pad_start(s: &str, target: f64, fill: &str) -> String {
    let len = s.chars().count();
    let target = if target.is_finite() { target.floor().max(0.0) as usize } else { 0 };
    if target <= len || fill.is_empty() {
        return s.to_string();
    }
    let fill: Vec<char> = fill.chars().collect();
    let pad: String = (0..target - len).map(|i| fill[i % fill.len()]).collect();
    pad + s
}

fn call_helper(name: &str, args: &[Option<Value>]) -> R<Option<Value>> {
    let a0 = arg(args, 0);
    let a1 = arg(args, 1);
    let n = |v: f64| Ok(Some(num_value(v)));
    let s = |v: String| Ok(Some(Value::String(v)));
    match name {
        "now" => s(format_date(&a0.map(|v| js_string(Some(v))).unwrap_or_else(|| "YYYY-MM-DD HH:mm:ss".into()))),
        "timestamp" => n(chrono::Utc::now().timestamp_millis() as f64),
        "uuid" => s(uuid::Uuid::new_v4().to_string()),
        "randomInt" => {
            let lo = a0.map_or(Ok(0.0), |v| to_num(Some(v), "randomInt"))?.ceil();
            let hi = a1.map_or(Ok(100.0), |v| to_num(Some(v), "randomInt"))?.floor();
            n(lo + (rand::thread_rng().gen::<f64>() * (hi - lo + 1.0)).floor())
        }
        "randomStr" => {
            let len = a0.map_or(Ok(8.0), |v| to_num(Some(v), "randomStr"))?.min(1000.0);
            let cs = a1.map(|v| js_string(Some(v))).unwrap_or_else(|| "alnum".into());
            let chars: Vec<char> = charset(&cs).map(String::from).unwrap_or(cs).chars().collect();
            if chars.is_empty() {
                return s(String::new());
            }
            let mut rng = rand::thread_rng();
            let mut out = String::new();
            let mut i = 0.0;
            while i < len {
                out.push(chars[rng.gen_range(0..chars.len())]);
                i += 1.0;
            }
            s(out)
        }
        "pick" => {
            if args.is_empty() {
                return Ok(None);
            }
            Ok(args[rand::thread_rng().gen_range(0..args.len())].clone())
        }
        "seq" => {
            let key = a0.map(|v| js_string(Some(v))).unwrap_or_else(|| "default".into());
            let mut counters = COUNTERS.lock().unwrap();
            let next = match counters.get(&key) {
                Some(prev) => prev + 1.0,
                None => a1.map_or(Ok(1.0), |v| to_num(Some(v), "seq"))?,
            };
            counters.insert(key, next);
            n(next)
        }
        "pad" => {
            let len = a1.map_or(Ok(2.0), |v| to_num(Some(v), "pad"))?;
            let fill = arg(args, 2).map(|v| js_string(Some(v))).unwrap_or_else(|| "0".into());
            s(pad_start(&as_text(a0), len, &fill))
        }
        "concat" => s(args.iter().map(|a| as_text(a.as_ref())).collect()),
        "add" => n(args.iter().map(|a| to_num(a.as_ref(), "add")).sum::<R<f64>>()?),
        "sub" => n(to_num(a0, "sub")? - to_num(a1, "sub")?),
        "mul" => n(args.iter().map(|a| to_num(a.as_ref(), "mul")).product::<R<f64>>()?),
        "div" => {
            let d = to_num(a1, "div")?;
            if d == 0.0 {
                return err("div 的除数不能为 0");
            }
            n(to_num(a0, "div")? / d)
        }
        "ceil" => n(to_num(a0, "ceil")?.ceil()),
        "floor" => n(to_num(a0, "floor")?.floor()),
        "round" => n((to_num(a0, "round")? + 0.5).floor()),
        "min" => n(args.iter().map(|a| to_num(a.as_ref(), "min")).collect::<R<Vec<_>>>()?.into_iter().fold(f64::INFINITY, f64::min)),
        "max" => n(args.iter().map(|a| to_num(a.as_ref(), "max")).collect::<R<Vec<_>>>()?.into_iter().fold(f64::NEG_INFINITY, f64::max)),
        "len" => {
            let l = match a0 {
                v if is_blank(v) => 0,
                Some(Value::Array(a)) => a.len(),
                Some(Value::String(t)) => utf16_len(t),
                Some(Value::Object(o)) => o.len(),
                other => utf16_len(&js_string(other)),
            };
            n(l as f64)
        }
        "upper" => s(as_text(a0).to_uppercase()),
        "lower" => s(as_text(a0).to_lowercase()),
        "default" => Ok(if is_blank(a0) { a1.cloned() } else { a0.cloned() }),
        "number" => n(to_num(a0, "number")?),
        "string" => s(as_text(a0)),
        "eq" => Ok(Some(Value::Bool(as_text(a0) == as_text(a1)))),
        "gt" => Ok(Some(Value::Bool(to_num(a0, "gt")? > to_num(a1, "gt")?))),
        "lt" => Ok(Some(Value::Bool(to_num(a0, "lt")? < to_num(a1, "lt")?))),
        "if" => {
            let pass = truthy(a0) && !matches!(a0, Some(Value::String(t)) if t == "false" || t == "0");
            Ok(if pass { a1.cloned() } else { Some(arg(args, 2).cloned().unwrap_or(Value::String(String::new()))) })
        }
        _ => err(format!("未知的函数: {}", name)),
    }
}

// ---------- 渲染 ----------

/// 找到 s 中的 {{...}}，返回 (开始, 结束, 表达式)。规则同正则 /\{\{((?:(?!\}\}).)*?)\}\}/
fn next_expr(s: &str, from: usize) -> Option<(usize, usize, &str)> {
    let mut i = from;
    while let Some(off) = s[i..].find("{{") {
        let start = i + off;
        if let Some(end_off) = s[start + 2..].find("}}") {
            let end = start + 2 + end_off;
            return Some((start, end + 2, &s[start + 2..end]));
        }
        i = start + 1;
        if i >= s.len() {
            break;
        }
        while !s.is_char_boundary(i) {
            i += 1;
        }
    }
    None
}

fn render_inline(s: &str, ctx: &Ctx) -> R<String> {
    let mut out = String::new();
    let mut pos = 0;
    while let Some((start, end, expr)) = next_expr(s, pos) {
        out.push_str(&s[pos..start]);
        out.push_str(&as_text(evaluate(expr, ctx)?.as_ref()));
        pos = end;
    }
    out.push_str(&s[pos..]);
    Ok(out)
}

/// 整个字符串只有一个 {{...}} 时保留原始类型（数字、数组等），否则拼接成字符串。None 表示 undefined
pub fn render_string_ctx(s: &str, ctx: &Ctx) -> R<Option<Value>> {
    if s.len() >= 4 && s.starts_with("{{") && s.ends_with("}}") && s[2..].find("}}") == Some(s.len() - 4) {
        return evaluate(&s[2..s.len() - 2], ctx);
    }
    Ok(Some(Value::String(render_inline(s, ctx)?)))
}

pub fn render_string(s: &str, base: &Obj) -> R<Option<Value>> {
    render_string_ctx(s, &Ctx::new(base))
}

/// 只做文本替换，不保留原始类型。用于发出去的请求
pub fn render_text(s: &str, base: &Obj) -> R<String> {
    render_inline(s, &Ctx::new(base))
}

fn render_node(node: &Value, ctx: &Ctx) -> R<Value> {
    match node {
        Value::String(s) => Ok(render_string_ctx(s, ctx)?.unwrap_or(Value::Null)),
        Value::Array(a) => Ok(Value::Array(a.iter().map(|n| render_node(n, ctx)).collect::<R<Vec<_>>>()?)),
        Value::Object(o) => {
            if let Some(rep) = o.get("$repeat") {
                let count = to_number(Some(&render_node(rep, ctx)?));
                if !count.is_finite() || count < 0.0 {
                    return err(format!("$repeat 的次数无效: {}", fmt_num(count)));
                }
                if count > MAX_REPEAT {
                    return err(format!("$repeat 次数不能超过 {}，当前为 {}", MAX_REPEAT, fmt_num(count)));
                }
                let item = o.get("$item").cloned().unwrap_or(Value::Null);
                let mut out = Vec::new();
                for i in 0..count.floor() as usize {
                    let mut extra = ctx.extra.clone();
                    let parent_index = ctx.get("$index").cloned();
                    let parent_no = ctx.get("$no").cloned();
                    extra.insert("$index".into(), Value::from(i));
                    extra.insert("$no".into(), Value::from(i + 1));
                    set_or_remove(&mut extra, "$parentIndex", parent_index);
                    set_or_remove(&mut extra, "$parentNo", parent_no);
                    out.push(render_node(&item, &Ctx { base: ctx.base, extra })?);
                }
                return Ok(Value::Array(out));
            }
            let mut out = Obj::new();
            for (k, v) in o {
                out.insert(k.clone(), render_node(v, ctx)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn set_or_remove(m: &mut Obj, key: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(key.into(), v);
        }
        // 用 Null 占位会让取值结果从 undefined 变成 null，这里用一个不可能出现的路径代替：直接删除即可，base 里不会有 $ 开头的键
        None => {
            m.remove(key);
        }
    }
}

/// 返回值是合法 JSON 时按 JSON 渲染，否则按纯文本渲染。返回 (内容, 是否 JSON)
pub fn render_body(text: &str, base: &Obj) -> R<(String, bool)> {
    if text.trim().is_empty() {
        return Ok((String::new(), false));
    }
    let ctx = Ctx::new(base);
    match crate::js::parse_json(text) {
        Err(_) => Ok((as_text(render_string_ctx(text, &ctx)?.as_ref()), false)),
        Ok(tree) => Ok((stringify(&render_node(&tree, &ctx)?), true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> Obj {
        json!({
            "body": { "taskNo": "T001", "quantity": 5, "items": [{ "code": "A" }] },
            "query": { "page": "2" },
            "headers": { "x-auth-token": "abc" }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn rs(s: &str) -> Option<Value> {
        render_string(s, &ctx()).unwrap()
    }

    #[test]
    fn whole_expression_keeps_type() {
        assert_eq!(rs("{{body.quantity}}"), Some(json!(5)));
        assert_eq!(rs("{{body.items}}"), Some(json!([{ "code": "A" }])));
    }

    #[test]
    fn inline_concat() {
        assert_eq!(rs("任务{{body.taskNo}}-{{query.page}}"), Some(json!("任务T001-2")));
        assert_eq!(rs("{{body.taskNo}}{{query.page}}"), Some(json!("T0012")));
    }

    #[test]
    fn paths() {
        assert_eq!(rs("{{body.items[0].code}}"), Some(json!("A")));
        assert_eq!(rs("{{headers.x-auth-token}}"), Some(json!("abc")));
        assert_eq!(rs("{{body.missing.deep}}"), None);
        assert_eq!(rs("{{body.taskNo.length}}"), Some(json!(4)));
    }

    #[test]
    fn helpers() {
        assert_eq!(rs("{{concat 'B' (pad 7 4)}}"), Some(json!("B0007")));
        assert_eq!(rs("{{ceil (div body.quantity 2)}}"), Some(json!(3)));
        assert_eq!(rs("{{default body.none 'x'}}"), Some(json!("x")));
        let d = rs("{{now 'YYYYMMDD'}}").unwrap();
        assert!(d.as_str().unwrap().len() == 8 && d.as_str().unwrap().chars().all(|c| c.is_ascii_digit()));
        let r = rs("{{randomStr 6 'digit'}}").unwrap();
        assert!(r.as_str().unwrap().len() == 6 && r.as_str().unwrap().chars().all(|c| c.is_ascii_digit()));
        assert_eq!(rs("{{div 1 4}}"), Some(json!(0.25)));
        assert_eq!(rs("x{{add 1 2}}"), Some(json!("x3")));
    }

    #[test]
    fn seq_and_lazy_if() {
        assert_eq!(rs("{{seq 'rs-test-seq' 10}}"), Some(json!(10)));
        assert_eq!(rs("{{seq 'rs-test-seq'}}"), Some(json!(11)));
        assert_eq!(rs("{{seq 'rs-lazy'}}"), Some(json!(1)));
        assert_eq!(rs("{{if (gt 1 2) (seq 'rs-lazy') 'no'}}"), Some(json!("no")));
        assert_eq!(rs("{{seq 'rs-lazy'}}"), Some(json!(2)));
        assert_eq!(rs("{{if (eq body.taskNo 'T001') 'yes'}}"), Some(json!("yes")));
    }

    #[test]
    fn repeat() {
        let tpl = json!({ "list": { "$repeat": "{{body.quantity}}", "$item": { "no": "{{$no}}", "idx": "{{$index}}" } } }).to_string();
        let (out, is_json) = render_body(&tpl, &ctx()).unwrap();
        assert!(is_json);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["list"].as_array().unwrap().len(), 5);
        assert_eq!(v["list"][4], json!({ "no": 5, "idx": 4 }));
    }

    #[test]
    fn text_body_and_order() {
        assert_eq!(render_body("hello {{body.taskNo}}", &ctx()).unwrap(), ("hello T001".into(), false));
        let (out, _) = render_body("{\"z\":1,\"a\":\"{{query.page}}\"}", &ctx()).unwrap();
        assert_eq!(out, "{\"z\":1,\"a\":\"2\"}");
    }

    #[test]
    fn errors() {
        assert!(render_string("{{unknownFn 1}}", &ctx()).is_err());
        assert!(render_string("{{concat 'a}}", &ctx()).unwrap_err().0.contains("引号"));
        assert!(render_string("{{div 1 0}}", &ctx()).unwrap_err().0.contains("除数"));
        let big = json!({ "x": { "$repeat": 999999 } }).to_string();
        assert!(render_body(&big, &ctx()).unwrap_err().0.contains("不能超过"));
    }

    #[test]
    fn no_prototype_access() {
        assert_eq!(rs("{{body.__proto__}}"), None);
        assert_eq!(rs("{{body.constructor}}"), None);
    }
}
