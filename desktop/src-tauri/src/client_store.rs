// 接口调用功能的持久化，对应 Node 版的 src/clientStore.js：
//   client.json   集合、请求、环境变量
//   records.json  用户手动「保存到服务器」的调用记录

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::js::{get, int_in, new_id, now_iso, text, truthy, valid_id, Obj};
use crate::store::{read_json_file, write_json_file, ApiError, ApiResult};
use crate::template::is_helper;

pub const CLIENT_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_MODES: [&str; 4] = ["none", "json", "form", "raw"];
const FORBIDDEN_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];
pub const MAX_RECORDS: usize = 500;
const RECORD_BODY_LIMIT: usize = 20000;
const NOTE_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub mode: String,
    pub json: String,
    pub form: Vec<Row>,
    pub raw: String,
    pub raw_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub timeout: i64,
    pub follow_redirects: bool,
    pub insecure: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestContent {
    pub name: String,
    pub method: String,
    pub url: String,
    pub params: Vec<Row>,
    pub headers: Vec<Row>,
    pub body: Body,
    pub options: Options,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRequest {
    pub id: String,
    pub collection_id: String,
    pub order: i64,
    #[serde(flatten)]
    pub content: RequestContent,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub vars: Vec<Row>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sent {
    pub method: String,
    pub url: String,
    pub headers: Obj,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResponse {
    pub status: i64,
    pub status_text: String,
    pub headers: Obj,
    pub body: String,
    pub binary: bool,
    pub content_type: String,
    pub size: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub total_ms: i64,
    pub ttfb_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub time: String,
    pub note: String,
    pub env_name: String,
    pub request: RequestContent,
    pub sent: Sent,
    pub response: Option<RecordResponse>,
    pub error: Option<ErrorInfo>,
    pub timing: Timing,
    pub redirects: Vec<String>,
}

fn s(v: &Value, key: &str) -> String {
    text(get(v, key), "")
}

fn one_of(list: &[&str], v: &str, fallback: &str) -> String {
    if list.contains(&v) {
        v.to_string()
    } else {
        fallback.to_string()
    }
}

// 留出截断提示的长度，读回已截断的内容时不会再截断一次
fn needs_truncate(s: &str) -> bool {
    s.chars().count() > RECORD_BODY_LIMIT + 100
}

fn truncate(s: &str) -> String {
    if needs_truncate(s) {
        let n = s.chars().count();
        format!("{}\n...（已截断，共 {} 字符）", s.chars().take(RECORD_BODY_LIMIT).collect::<String>(), n)
    } else {
        s.to_string()
    }
}

pub fn normalize_rows(rows: Option<&Value>) -> Vec<Row> {
    rows.and_then(|x| x.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|r| Row { key: s(r, "key"), value: s(r, "value"), enabled: !matches!(get(r, "enabled"), Some(Value::Bool(false))) })
        .filter(|r| !r.key.trim().is_empty() || !r.value.trim().is_empty())
        .collect()
}

fn normalize_string_map(obj: Option<&Value>) -> Obj {
    let mut out = Obj::new();
    if let Some(Value::Object(o)) = obj {
        for (k, v) in o {
            let t = match v {
                Value::Array(a) => a.iter().map(|x| text(Some(x), "")).collect::<Vec<_>>().join(", "),
                other => text(Some(other), ""),
            };
            out.insert(k.clone(), Value::String(t));
        }
    }
    out
}

fn normalize_options(o: Option<&Value>) -> Options {
    let src = o.cloned().unwrap_or(Value::Null);
    Options {
        timeout: int_in(get(&src, "timeout"), 30000, 1000, 300000),
        follow_redirects: !matches!(get(&src, "followRedirects"), Some(Value::Bool(false))),
        insecure: matches!(get(&src, "insecure"), Some(Value::Bool(true))),
    }
}

/// 请求内容（不含 id / 集合等归属信息），发送和保存共用
pub fn normalize_request_content(r: Option<&Value>) -> RequestContent {
    let r = r.cloned().unwrap_or(Value::Null);
    let body = get(&r, "body").cloned().unwrap_or(Value::Null);
    let raw_type = s(&body, "rawType").trim().to_string();
    RequestContent {
        name: s(&r, "name").trim().to_string(),
        method: one_of(&CLIENT_METHODS, &s(&r, "method").to_uppercase(), "GET"),
        url: s(&r, "url").trim().to_string(),
        params: normalize_rows(get(&r, "params")),
        headers: normalize_rows(get(&r, "headers")),
        body: Body {
            mode: one_of(&BODY_MODES, &s(&body, "mode"), "none"),
            json: s(&body, "json"),
            form: normalize_rows(get(&body, "form")),
            raw: s(&body, "raw"),
            raw_type: if raw_type.is_empty() { "text/plain".into() } else { raw_type },
        },
        options: normalize_options(get(&r, "options")),
    }
}

fn valid_var_name(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn normalize_vars(vars: Option<&Value>, strict: bool) -> ApiResult<Vec<Row>> {
    let mut out: Vec<Row> = Vec::new();
    for v in normalize_rows(vars) {
        let key = v.key.trim().to_string();
        if key.is_empty() {
            continue;
        }
        let problem = if !valid_var_name(&key) || FORBIDDEN_NAMES.contains(&key.as_str()) {
            Some(format!("变量名「{}」不合法：只能包含字母、数字、_、-，并且以字母或下划线开头", key))
        } else if is_helper(&key) {
            Some(format!("变量名「{}」和内置函数重名，请换一个", key))
        } else if out.iter().any(|x| x.key == key) {
            Some(format!("变量「{}」重复了", key))
        } else {
            None
        };
        if let Some(msg) = problem {
            if strict {
                return Err(ApiError::new(msg));
            }
            continue;
        }
        out.push(Row { key, value: v.value, enabled: v.enabled });
    }
    Ok(out)
}

fn normalize_environment(e: &Value, index: usize) -> ApiResult<Environment> {
    let name = s(e, "name").trim().to_string();
    let name = if name.is_empty() { format!("环境{}", index + 1) } else { name };
    let vars = normalize_vars(get(e, "vars"), true).map_err(|err| ApiError::new(format!("环境「{}」中的{}", name, err.message)))?;
    let id = s(e, "id");
    Ok(Environment { id: if valid_id(&id) { id } else { new_id() }, name, vars })
}

fn parse_time(t: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn normalize_record(r: &Value) -> Record {
    let sent = get(r, "sent").cloned().unwrap_or(Value::Null);
    let timing = get(r, "timing").cloned().unwrap_or(Value::Null);
    let response = match get(r, "response") {
        Some(resp) if truthy(Some(resp)) => {
            let body = s(resp, "body");
            Some(RecordResponse {
                status: int_in(get(resp, "status"), 0, 0, 999),
                status_text: s(resp, "statusText"),
                headers: normalize_string_map(get(resp, "headers")),
                body: truncate(&body),
                binary: matches!(get(resp, "binary"), Some(Value::Bool(true))),
                content_type: s(resp, "contentType"),
                size: int_in(get(resp, "size"), 0, 0, i64::MAX),
                truncated: matches!(get(resp, "truncated"), Some(Value::Bool(true))) || needs_truncate(&body),
            })
        }
        _ => None,
    };
    let error = match get(r, "error") {
        Some(e) if truthy(Some(e)) => Some(ErrorInfo { code: s(e, "code"), message: s(e, "message") }),
        _ => None,
    };
    let sent_body = match get(&sent, "body") {
        None | Some(Value::Null) => None,
        Some(b) => Some(truncate(&text(Some(b), ""))),
    };
    Record {
        id: new_id(),
        time: parse_time(&s(r, "time")).unwrap_or_else(now_iso),
        note: s(r, "note").trim().chars().take(NOTE_LIMIT).collect(),
        env_name: s(r, "envName").chars().take(100).collect(),
        request: normalize_request_content(get(r, "request")),
        sent: Sent { method: s(&sent, "method"), url: s(&sent, "url"), headers: normalize_string_map(get(&sent, "headers")), body: sent_body },
        response,
        error,
        timing: Timing {
            total_ms: int_in(get(&timing, "totalMs"), 0, 0, i64::MAX),
            ttfb_ms: if matches!(get(&timing, "ttfbMs"), Some(Value::Null)) { None } else { Some(int_in(get(&timing, "ttfbMs"), 0, 0, i64::MAX)) },
        },
        redirects: get(r, "redirects").and_then(|x| x.as_array()).map(|a| a.iter().take(10).map(|x| text(Some(x), "")).collect()).unwrap_or_default(),
    }
}

fn record_summary(r: &Record) -> Value {
    json!({
        "id": r.id,
        "time": r.time,
        "note": r.note,
        "envName": r.env_name,
        "name": r.request.name,
        "method": if r.sent.method.is_empty() { &r.request.method } else { &r.sent.method },
        "url": if r.sent.url.is_empty() { &r.request.url } else { &r.sent.url },
        "status": r.response.as_ref().map(|x| x.status),
        "error": r.error.as_ref().map(|e| e.code.clone()),
        "totalMs": r.timing.total_ms,
    })
}

fn next_order<T>(list: &[T], order: impl Fn(&T) -> i64) -> i64 {
    list.iter().map(order).max().unwrap_or(-1) + 1
}

pub struct PreparedImport {
    pub collections: Vec<Collection>,
    pub requests: Vec<SavedRequest>,
    pub collection_count: usize,
    pub request_count: usize,
}

pub struct ClientStore {
    client_file: PathBuf,
    records_file: PathBuf,
    pub collections: Vec<Collection>,
    pub requests: Vec<SavedRequest>,
    pub environments: Vec<Environment>,
    pub records: Vec<Record>,
}

impl ClientStore {
    pub fn open(client_file: PathBuf, records_file: PathBuf) -> Result<Self, String> {
        let mut st = ClientStore { client_file, records_file, collections: vec![], requests: vec![], environments: vec![], records: vec![] };
        if st.client_file.exists() {
            let raw = read_json_file(&st.client_file)?;
            st.collections = get(&raw, "collections").and_then(|x| x.as_array()).cloned().unwrap_or_default().iter().map(normalize_collection).collect();
            let ids: Vec<String> = st.collections.iter().map(|c| c.id.clone()).collect();
            st.requests = get(&raw, "requests")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(normalize_saved_request)
                .filter(|r| ids.contains(&r.collection_id))
                .collect();
            // 读文件时不因为个别变量名不合法而启动失败
            st.environments = get(&raw, "environments")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let id = s(e, "id");
                    let name = s(e, "name").trim().to_string();
                    Environment {
                        id: if valid_id(&id) { id } else { new_id() },
                        name: if name.is_empty() { format!("环境{}", i + 1) } else { name },
                        vars: normalize_vars(get(e, "vars"), false).unwrap_or_default(),
                    }
                })
                .collect();
        }
        if st.records_file.exists() {
            let raw = read_json_file(&st.records_file)?;
            st.records = get(&raw, "records")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    let mut rec = normalize_record(r);
                    let id = s(r, "id");
                    if valid_id(&id) {
                        rec.id = id;
                    }
                    rec
                })
                .collect();
        }
        Ok(st)
    }

    pub fn snapshot(&self) -> Value {
        let mut cols = self.collections.clone();
        cols.sort_by(|a, b| a.order.cmp(&b.order).then(a.created_at.cmp(&b.created_at)));
        let mut reqs = self.requests.clone();
        reqs.sort_by(|a, b| a.order.cmp(&b.order).then(a.created_at.cmp(&b.created_at)));
        json!({ "collections": cols, "requests": reqs, "environments": self.environments })
    }

    // ---------- 集合 ----------

    pub fn create_collection(&mut self, input: &Value) -> ApiResult<Collection> {
        let c = normalize_collection(&json!({ "name": get(input, "name"), "order": next_order(&self.collections, |c| c.order) }));
        self.collections.push(c.clone());
        self.save_client()?;
        Ok(c)
    }

    pub fn update_collection(&mut self, id: &str, input: &Value) -> ApiResult<Collection> {
        let c = self.collections.iter_mut().find(|x| x.id == id).ok_or_else(|| ApiError::with(404, "集合不存在"))?;
        if get(input, "name").is_some() {
            let name = s(input, "name").trim().to_string();
            if !name.is_empty() {
                c.name = name;
            }
        }
        c.updated_at = now_iso();
        let out = c.clone();
        self.save_client()?;
        Ok(out)
    }

    pub fn remove_collection(&mut self, id: &str) -> ApiResult<()> {
        if !self.collections.iter().any(|x| x.id == id) {
            return Err(ApiError::with(404, "集合不存在"));
        }
        self.collections.retain(|x| x.id != id);
        self.requests.retain(|r| r.collection_id != id);
        self.save_client()
    }

    // ---------- 请求 ----------

    fn assert_collection(&self, id: &str) -> ApiResult<()> {
        if self.collections.iter().any(|c| c.id == id) {
            Ok(())
        } else {
            Err(ApiError::new("请选择一个已有的集合"))
        }
    }

    pub fn create_request(&mut self, input: &Value) -> ApiResult<SavedRequest> {
        let collection_id = s(input, "collectionId");
        self.assert_collection(&collection_id)?;
        let siblings: Vec<&SavedRequest> = self.requests.iter().filter(|r| r.collection_id == collection_id).collect();
        let order = siblings.iter().map(|r| r.order).max().unwrap_or(-1) + 1;
        let mut src = input.clone();
        if let Some(o) = src.as_object_mut() {
            o.remove("id");
            o.remove("createdAt");
            o.remove("updatedAt");
            o.insert("order".into(), json!(order));
        }
        let req = normalize_saved_request(&src);
        self.requests.push(req.clone());
        self.save_client()?;
        Ok(req)
    }

    pub fn update_request(&mut self, id: &str, input: &Value) -> ApiResult<SavedRequest> {
        let index = self.requests.iter().position(|r| r.id == id).ok_or_else(|| ApiError::with(404, "请求不存在，可能已被删除"))?;
        let old = self.requests[index].clone();
        let given = s(input, "collectionId");
        let collection_id = if given.is_empty() { old.collection_id.clone() } else { given };
        self.assert_collection(&collection_id)?;
        let order = if collection_id == old.collection_id {
            old.order
        } else {
            next_order(&self.requests.iter().filter(|r| r.collection_id == collection_id).collect::<Vec<_>>(), |r| r.order)
        };
        let mut src = if input.is_object() { input.clone() } else { json!({}) };
        let o = src.as_object_mut().unwrap();
        o.insert("id".into(), json!(id));
        o.insert("collectionId".into(), json!(collection_id));
        o.insert("order".into(), json!(order));
        o.insert("createdAt".into(), json!(old.created_at));
        o.insert("updatedAt".into(), json!(now_iso()));
        self.requests[index] = normalize_saved_request(&src);
        let out = self.requests[index].clone();
        self.save_client()?;
        Ok(out)
    }

    pub fn remove_request(&mut self, id: &str) -> ApiResult<()> {
        if !self.requests.iter().any(|r| r.id == id) {
            return Err(ApiError::with(404, "请求不存在"));
        }
        self.requests.retain(|r| r.id != id);
        self.save_client()
    }

    // ---------- 环境 ----------

    pub fn set_environments(&mut self, list: Option<&Value>) -> ApiResult<Vec<Environment>> {
        let list = list.and_then(|x| x.as_array()).ok_or_else(|| ApiError::new("环境列表格式不正确"))?;
        let envs = list.iter().enumerate().map(|(i, e)| normalize_environment(e, i)).collect::<ApiResult<Vec<_>>>()?;
        let mut ids: Vec<&String> = envs.iter().map(|e| &e.id).collect();
        ids.sort();
        ids.dedup();
        if ids.len() != envs.len() {
            return Err(ApiError::new("环境 id 重复"));
        }
        self.environments = envs.clone();
        self.save_client()?;
        Ok(envs)
    }

    // ---------- 服务器记录 ----------

    pub fn list_records(&self) -> Vec<Value> {
        let mut list: Vec<&Record> = self.records.iter().collect();
        list.sort_by(|a, b| b.time.cmp(&a.time));
        list.into_iter().map(record_summary).collect()
    }

    pub fn get_record(&self, id: &str) -> ApiResult<&Record> {
        self.records.iter().find(|r| r.id == id).ok_or_else(|| ApiError::with(404, "记录不存在"))
    }

    pub fn create_record(&mut self, input: &Value) -> ApiResult<Value> {
        if self.records.len() >= MAX_RECORDS {
            return Err(ApiError::with(409, format!("服务器记录已达 {} 条上限，请先删除一些旧记录", MAX_RECORDS)));
        }
        let r = normalize_record(input);
        let summary = record_summary(&r);
        self.records.push(r);
        self.save_records()?;
        Ok(summary)
    }

    pub fn update_record(&mut self, id: &str, input: &Value) -> ApiResult<Value> {
        let r = self.records.iter_mut().find(|x| x.id == id).ok_or_else(|| ApiError::with(404, "记录不存在"))?;
        if get(input, "note").is_some() {
            r.note = s(input, "note").trim().chars().take(NOTE_LIMIT).collect();
        }
        let summary = record_summary(r);
        self.save_records()?;
        Ok(summary)
    }

    pub fn remove_record(&mut self, id: &str) -> ApiResult<()> {
        self.get_record(id)?;
        self.records.retain(|x| x.id != id);
        self.save_records()
    }

    // ---------- 导出导入（不包含环境变量和记录） ----------

    pub fn export_data(&self) -> Value {
        let snap = self.snapshot();
        json!({ "collections": snap["collections"], "requests": snap["requests"] })
    }

    /// 先校验、算出导入后的结果；和接口配置的导入一起「要么都成功，要么都不改」
    pub fn prepare_import(&self, data: &Value, mode: &str) -> ApiResult<PreparedImport> {
        let (Some(cols_in), Some(reqs_in)) = (get(data, "collections").and_then(|x| x.as_array()), get(data, "requests").and_then(|x| x.as_array())) else {
            return Err(ApiError::new("导入内容格式不正确，client 中应包含 collections 和 requests"));
        };
        let incoming_cols: Vec<Collection> = cols_in.iter().map(normalize_collection).collect();
        let incoming_reqs: Vec<SavedRequest> = reqs_in.iter().map(normalize_saved_request).collect();
        let mut cols = if mode == "replace" { vec![] } else { self.collections.clone() };
        let mut reqs = if mode == "replace" { vec![] } else { self.requests.clone() };
        for c in &incoming_cols {
            match cols.iter().position(|x| x.id == c.id) {
                None => cols.push(c.clone()),
                Some(i) => cols[i] = c.clone(),
            }
        }
        for r in &incoming_reqs {
            if !cols.iter().any(|c| c.id == r.collection_id) {
                return Err(ApiError::new(format!("请求「{}」所属的集合不存在", r.content.name)));
            }
            match reqs.iter().position(|x| x.id == r.id) {
                None => reqs.push(r.clone()),
                Some(i) => reqs[i] = r.clone(),
            }
        }
        Ok(PreparedImport { collections: cols, requests: reqs, collection_count: incoming_cols.len(), request_count: incoming_reqs.len() })
    }

    pub fn commit_import(&mut self, p: PreparedImport) -> ApiResult<()> {
        self.collections = p.collections;
        self.requests = p.requests;
        self.save_client()
    }

    // ---------- 保存 ----------

    fn save_client(&self) -> ApiResult<()> {
        write_json_file(
            &self.client_file,
            &json!({ "version": 1, "collections": self.collections, "requests": self.requests, "environments": self.environments }),
        )
    }

    fn save_records(&self) -> ApiResult<()> {
        write_json_file(&self.records_file, &json!({ "version": 1, "records": self.records }))
    }
}

fn normalize_collection(c: &Value) -> Collection {
    let now = now_iso();
    let id = s(c, "id");
    let name = s(c, "name").trim().to_string();
    let created = s(c, "createdAt");
    let updated = s(c, "updatedAt");
    Collection {
        id: if valid_id(&id) { id } else { new_id() },
        name: if name.is_empty() { "未命名集合".into() } else { name },
        order: int_in(get(c, "order"), 0, 0, 1_000_000),
        created_at: if created.is_empty() { now.clone() } else { created },
        updated_at: if updated.is_empty() { now } else { updated },
    }
}

fn normalize_saved_request(r: &Value) -> SavedRequest {
    let now = now_iso();
    let mut content = normalize_request_content(Some(r));
    if content.name.is_empty() {
        content.name = if content.url.is_empty() { "未命名请求".into() } else { content.url.clone() };
    }
    let id = s(r, "id");
    let created = s(r, "createdAt");
    let updated = s(r, "updatedAt");
    SavedRequest {
        id: if valid_id(&id) { id } else { new_id() },
        collection_id: s(r, "collectionId"),
        order: int_in(get(r, "order"), 0, 0, 1_000_000),
        content,
        created_at: if created.is_empty() { now.clone() } else { created },
        updated_at: if updated.is_empty() { now } else { updated },
    }
}
