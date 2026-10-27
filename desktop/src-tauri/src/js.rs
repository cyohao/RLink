// 和 JavaScript 行为一致的小工具：数字格式、类型转换、真假值判断等。
// Node 版里很多结果依赖 JS 的隐式转换，这里逐个对齐，保证两边输出相同。

use rand::Rng;
use serde_json::{Map, Number, Value};

pub type Obj = Map<String, Value>;

/// JS 的 undefined / null / ''
pub fn is_blank(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

/// 把 f64 转成 JSON 数字：整数输出为 3 而不是 3.0；NaN / Infinity 和 JSON.stringify 一样变成 null
pub fn num_value(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f == f.trunc() && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// JS 的 String(number)
pub fn fmt_num(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == f.trunc() && f.abs() < 1e21 {
        return format!("{}", f as i128);
    }
    if f.abs() < 1e-6 || f.abs() >= 1e21 {
        return format!("{:e}", f);
    }
    format!("{}", f)
}

fn number_to_f64(n: &Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

/// JS 的 Number(string)
pub fn str_to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    // 只接受十进制写法，避免 Rust 额外认可的 "inf"、"nan" 等
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS 的 Number(value)，None 表示 undefined
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => number_to_f64(n),
        Some(Value::String(s)) => str_to_number(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => str_to_number(&js_string(Some(&a[0]))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// JS 的 String(value)
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => fmt_num(number_to_f64(n)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// 模板里的 asText：空值为 ''，对象和数组转成 JSON
pub fn as_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::Object(_)) | Some(Value::Array(_)) => stringify(v.unwrap()),
        other => js_string(other),
    }
}

/// store.js 里的 text(v, fallback)：undefined / null 时用默认值
pub fn text(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.to_string(),
        other => js_string(other),
    }
}

/// JS 的真假值
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let f = number_to_f64(n);
            f != 0.0 && !f.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

/// JS 字符串的 length（按 UTF-16 计）
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS 的 parseInt(String(v), 10)
pub fn parse_int(v: Option<&Value>) -> Option<i64> {
    let s = match v {
        None => return None,
        Some(Value::Number(n)) if n.is_i64() => return n.as_i64(),
        other => js_string(other),
    };
    let t = s.trim_start();
    let mut chars = t.chars().peekable();
    let mut neg = false;
    if let Some(&c) = chars.peek() {
        if c == '+' || c == '-' {
            neg = c == '-';
            chars.next();
        }
    }
    let digits: String = chars.take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if neg { -n } else { n })
}

/// store.js 里的 intIn
pub fn int_in(v: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    match parse_int(v) {
        None => fallback,
        Some(n) => n.max(min).min(max),
    }
}

/// JSON.stringify
pub fn stringify(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

pub fn stringify_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// JSON.parse：把 1.0 这类整数值的浮点数规范成整数，和 JS 一致
pub fn parse_json(s: &str) -> Result<Value, serde_json::Error> {
    let mut v: Value = serde_json::from_str(s)?;
    normalize_numbers(&mut v);
    Ok(v)
}

fn normalize_numbers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if n.is_f64() {
                *v = num_value(n.as_f64().unwrap_or(f64::NAN));
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize_numbers),
        Value::Object(o) => o.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// new Date().toISOString()
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// crypto.randomBytes(6).toString('hex')
pub fn new_id() -> String {
    let mut rng = rand::thread_rng();
    (0..6).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

/// /^[\w-]{1,64}$/
pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn get<'a>(o: &'a Value, key: &str) -> Option<&'a Value> {
    o.as_object().and_then(|m| m.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(fmt_num(3.0), "3");
        assert_eq!(fmt_num(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(str_to_number(" 12 "), 12.0);
        assert!(str_to_number("12abc").is_nan());
        assert!(str_to_number("inf").is_nan());
        assert_eq!(str_to_number("0x10"), 16.0);
        assert_eq!(num_value(2.5), serde_json::json!(2.5));
        assert_eq!(num_value(2.0), serde_json::json!(2));
        assert_eq!(parse_int(Some(&serde_json::json!("12.9px"))), Some(12));
        assert_eq!(parse_int(Some(&serde_json::json!(" -3"))), Some(-3));
        assert_eq!(parse_json("{\"a\":1.0}").unwrap().to_string(), "{\"a\":1}");
    }
}
