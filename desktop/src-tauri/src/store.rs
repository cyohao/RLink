// 模拟接口配置的持久化，对应 Node 版的 src/store.js。文件格式完全一致，可以互相拷贝。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::js::{get, int_in, new_id, now_iso, parse_json, text, valid_id, Obj};

pub const METHODS: [&str; 6] = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"];
const RULE_SOURCES: [&str; 4] = ["body", "query", "params", "headers"];
const RULE_TYPES: [&str; 7] = ["any", "string", "number", "integer", "boolean", "array", "object"];
const OPERATORS: [&str; 9] = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists", "notExists"];
const RESERVED_PATHS: [&str; 2] = ["/__admin", "/__health"];
const DEFAULT_VALIDATION_BODY: &str = "{\n  \"code\": \"400\",\n  \"msg\": \"{{error}}\",\n  \"data\": null\n}";

/// 对应 Node 版的 StoreError：带 HTTP 状态码的业务错误
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(message: impl Into<String>) -> Self {
        ApiError { status: 400, message: message.into() }
    }
    pub fn with(status: u16, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Serialize)]
pub struct Resp {
    pub status: i64,
    pub headers: Obj,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    #[serde(rename = "in")]
    pub source: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub required: bool,
    pub max_length: i64,
    #[serde(rename = "enum")]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Condition {
    pub field: String,
    pub op: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Scenario {
    pub name: String,
    pub enabled: bool,
    #[serde(rename = "match")]
    pub match_mode: String,
    pub conditions: Vec<Condition>,
    pub response: Resp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mock {
    pub id: String,
    pub name: String,
    pub description: String,
    pub method: String,
    pub path: String,
    pub enabled: bool,
    pub delay: i64,
    pub rules: Vec<Rule>,
    pub validation_response: Resp,
    pub scenarios: Vec<Scenario>,
    pub response: Resp,
    pub created_at: String,
    pub updated_at: String,
}

fn one_of(list: &[&str], v: &str, fallback: &str) -> String {
    if list.contains(&v) {
        v.to_string()
    } else {
        fallback.to_string()
    }
}

fn s(v: &Value, key: &str) -> String {
    text(get(v, key), "")
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    get(v, key).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// enabled !== false
fn not_false(v: &Value, key: &str) -> bool {
    !matches!(get(v, key), Some(Value::Bool(false)))
}

/// Boolean(v)
fn bool_of(v: &Value, key: &str) -> bool {
    crate::js::truthy(get(v, key))
}

pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().split('?').next().unwrap_or("").to_string();
    if !s.starts_with('/') {
        s = format!("/{}", s);
    }
    let mut out = String::new();
    for c in s.chars() {
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    if out.len() > 1 {
        out = out.trim_end_matches('/').to_string();
        if out.is_empty() {
            out = "/".into();
        }
    }
    out
}

/// 兼容 {key: value} 和 [{key, value}] 两种写法
pub fn normalize_headers(h: Option<&Value>) -> Obj {
    let mut out = Obj::new();
    let mut put = |k: Option<&Value>, v: Option<&Value>| {
        let key = text(k, "").trim().to_string();
        if !key.is_empty() {
            out.insert(key, Value::String(text(v, "")));
        }
    };
    match h {
        Some(Value::Array(a)) => a.iter().for_each(|x| put(get(x, "key"), get(x, "value"))),
        Some(Value::Object(o)) => o.iter().for_each(|(k, v)| put(Some(&Value::String(k.clone())), Some(v))),
        _ => {}
    }
    out
}

fn normalize_response(r: Option<&Value>, default_status: i64, default_body: &str) -> Resp {
    let src = r.cloned().unwrap_or(Value::Null);
    Resp {
        status: int_in(get(&src, "status"), default_status, 100, 599),
        headers: normalize_headers(get(&src, "headers")),
        body: text(get(&src, "body"), default_body),
    }
}

fn normalize_rule(r: &Value) -> Rule {
    let options: Vec<String> = match get(r, "enum") {
        Some(Value::Array(a)) => a.iter().map(|x| text(Some(x), "").trim().to_string()).collect(),
        other => text(other, "").split([',', '，']).map(|x| x.trim().to_string()).collect(),
    };
    Rule {
        source: one_of(&RULE_SOURCES, &s(r, "in"), "body"),
        name: s(r, "name").trim().to_string(),
        kind: one_of(&RULE_TYPES, &s(r, "type"), "any"),
        required: bool_of(r, "required"),
        max_length: int_in(get(r, "maxLength"), 0, 0, 1_000_000),
        options: options.into_iter().filter(|x| !x.is_empty()).collect(),
    }
}

fn normalize_scenario(sc: &Value, index: usize) -> Scenario {
    let conditions = arr(sc, "conditions")
        .iter()
        .map(|c| Condition { field: s(c, "field").trim().to_string(), op: one_of(&OPERATORS, &s(c, "op"), "eq"), value: s(c, "value") })
        .filter(|c| !c.field.is_empty())
        .collect();
    let name = s(sc, "name").trim().to_string();
    Scenario {
        name: if name.is_empty() { format!("场景{}", index + 1) } else { name },
        enabled: not_false(sc, "enabled"),
        match_mode: if s(sc, "match") == "any" { "any".into() } else { "all".into() },
        conditions,
        response: normalize_response(get(sc, "response"), 200, "{}"),
    }
}

pub fn normalize_mock(m: &Value) -> ApiResult<Mock> {
    let method = text(get(m, "method"), "GET").to_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(ApiError::new(format!("不支持的请求方法: {}", method)));
    }
    if s(m, "path").trim().is_empty() {
        return Err(ApiError::new("接口路径不能为空"));
    }
    let p = normalize_path(&s(m, "path"));
    if RESERVED_PATHS.iter().any(|r| p == *r || p.starts_with(&format!("{}/", r))) {
        return Err(ApiError::new(format!("{} 是系统保留路径，请换一个", p)));
    }
    let segments: Vec<&str> = p.split('/').collect();
    if let Some(star) = segments.iter().position(|x| *x == "*") {
        if star != segments.len() - 1 {
            return Err(ApiError::new("通配符 * 只能放在路径最后"));
        }
    }
    let now = now_iso();
    let id = s(m, "id").trim().to_string();
    let name = s(m, "name").trim().to_string();
    let created = s(m, "createdAt");
    let updated = s(m, "updatedAt");
    Ok(Mock {
        id: if valid_id(&id) { id } else { new_id() },
        name: if name.is_empty() { p.clone() } else { name },
        description: s(m, "description"),
        method,
        path: p,
        enabled: not_false(m, "enabled"),
        delay: int_in(get(m, "delay"), 0, 0, 60000),
        rules: arr(m, "rules").iter().map(normalize_rule).filter(|r| !r.name.is_empty()).collect(),
        validation_response: normalize_response(get(m, "validationResponse"), 400, DEFAULT_VALIDATION_BODY),
        scenarios: arr(m, "scenarios").iter().enumerate().map(|(i, x)| normalize_scenario(x, i)).collect(),
        response: normalize_response(get(m, "response"), 200, "{}"),
        created_at: if created.is_empty() { now.clone() } else { created },
        updated_at: if updated.is_empty() { now } else { updated },
    })
}

// ---------- 文件读写 ----------

/// 先写临时文件再改名，避免写一半损坏
pub fn write_json_file(file: &Path, data: &Value) -> ApiResult<()> {
    let run = || -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = PathBuf::from(format!("{}.tmp", file.display()));
        fs::write(&tmp, crate::js::stringify_pretty(data))?;
        fs::rename(&tmp, file)
    };
    run().map_err(|e| ApiError::with(500, format!("保存文件失败 {}: {}", file.display(), e)))
}

pub fn read_json_file(file: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(file).map_err(|e| format!("读取配置文件失败 {}: {}", file.display(), e))?;
    // 不自动覆盖损坏的文件，避免丢配置
    parse_json(raw.trim_start_matches('\u{feff}')).map_err(|e| format!("读取配置文件失败 {}: {}", file.display(), e))
}

pub struct Store {
    file: PathBuf,
    pub mocks: Vec<Mock>,
}

impl Store {
    pub fn open(file: PathBuf, seeds: &Value) -> Result<Self, String> {
        if file.exists() {
            let raw = read_json_file(&file)?;
            let list = match &raw {
                Value::Array(a) => a.clone(),
                other => get(other, "mocks").and_then(|x| x.as_array()).cloned().unwrap_or_default(),
            };
            let mocks = list.iter().map(normalize_mock).collect::<ApiResult<Vec<_>>>().map_err(|e| format!("配置文件 {} 中有错误：{}", file.display(), e.message))?;
            Ok(Store { file, mocks })
        } else {
            let mocks = seeds.as_array().map(|a| a.iter().filter_map(|x| normalize_mock(x).ok()).collect()).unwrap_or_default();
            let store = Store { file, mocks };
            store.save().map_err(|e| e.message)?;
            Ok(store)
        }
    }

    pub fn list(&self) -> &[Mock] {
        &self.mocks
    }

    pub fn get(&self, id: &str) -> Option<&Mock> {
        self.mocks.iter().find(|m| m.id == id)
    }

    pub fn create(&mut self, input: &Value) -> ApiResult<Mock> {
        let mut src = input.clone();
        if let Some(o) = src.as_object_mut() {
            o.remove("id");
            o.remove("createdAt");
            o.remove("updatedAt");
        }
        let mock = normalize_mock(&src)?;
        self.assert_unique(&mock, None)?;
        self.mocks.push(mock.clone());
        self.save()?;
        Ok(mock)
    }

    pub fn update(&mut self, id: &str, input: &Value) -> ApiResult<Mock> {
        let index = self.mocks.iter().position(|m| m.id == id).ok_or_else(|| ApiError::with(404, "接口不存在"))?;
        let mut src = if input.is_object() { input.clone() } else { json!({}) };
        let o = src.as_object_mut().unwrap();
        o.insert("id".into(), json!(id));
        o.insert("createdAt".into(), json!(self.mocks[index].created_at));
        o.insert("updatedAt".into(), json!(now_iso()));
        let mock = normalize_mock(&src)?;
        self.assert_unique(&mock, Some(id))?;
        self.mocks[index] = mock.clone();
        self.save()?;
        Ok(mock)
    }

    pub fn remove(&mut self, id: &str) -> ApiResult<()> {
        let index = self.mocks.iter().position(|m| m.id == id).ok_or_else(|| ApiError::with(404, "接口不存在"))?;
        self.mocks.remove(index);
        self.save()
    }

    /// 校验并算出导入后的结果，不修改当前数据
    pub fn prepare_import(&self, list: Option<&Value>, mode: &str) -> ApiResult<(Vec<Mock>, usize)> {
        let list = list.and_then(|x| x.as_array()).ok_or_else(|| ApiError::new("导入内容格式不正确，应包含接口数组"))?;
        let incoming = list.iter().map(normalize_mock).collect::<ApiResult<Vec<_>>>()?;
        let mut next: Vec<Mock> = if mode == "replace" { Vec::new() } else { self.mocks.clone() };
        for m in &incoming {
            match next.iter().position(|x| x.id == m.id || (x.method == m.method && x.path == m.path)) {
                None => next.push(m.clone()),
                Some(i) => {
                    let id = next[i].id.clone();
                    next[i] = Mock { id, ..m.clone() };
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        for m in &next {
            let key = format!("{} {}", m.method, m.path);
            if !seen.insert(key.clone()) {
                return Err(ApiError::with(409, format!("导入后会出现重复的接口: {}", key)));
            }
        }
        Ok((next, incoming.len()))
    }

    pub fn commit_import(&mut self, next: Vec<Mock>) -> ApiResult<()> {
        self.mocks = next;
        self.save()
    }

    fn assert_unique(&self, mock: &Mock, ignore_id: Option<&str>) -> ApiResult<()> {
        if let Some(dup) = self.mocks.iter().find(|m| Some(m.id.as_str()) != ignore_id && m.method == mock.method && m.path == mock.path) {
            return Err(ApiError::with(409, format!("已存在相同的接口 {} {}（{}）", mock.method, mock.path, dup.name)));
        }
        Ok(())
    }

    pub fn save(&self) -> ApiResult<()> {
        write_json_file(&self.file, &json!({ "version": 1, "mocks": self.mocks }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(normalize_path("box/:code/"), "/box/:code");
        assert_eq!(normalize_path("//a//b?x=1"), "/a/b");
        assert_eq!(normalize_path("/"), "/");
    }

    #[test]
    fn mock_defaults() {
        let m = normalize_mock(&json!({ "method": "get", "path": "x", "rules": [{ "name": "a", "enum": "1，2, 3" }] })).unwrap();
        assert_eq!(m.method, "GET");
        assert_eq!(m.path, "/x");
        assert_eq!(m.rules[0].options, vec!["1", "2", "3"]);
        assert_eq!(m.validation_response.status, 400);
        assert!(normalize_mock(&json!({ "path": "/__admin/x" })).is_err());
        assert!(normalize_mock(&json!({ "path": "/a/*/b" })).is_err());
    }
}
