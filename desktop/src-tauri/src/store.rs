// Settings, admin login and saved receipts, kept as JSON files in the app's
// data folder (%LOCALAPPDATA%\com.nyt.parking-manager.desktop). The file
// formats match the browser print service, so its data can be imported.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Admin {
  pub username: String,
  pub salt: String,
  pub hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
  pub printer_name: String,
  pub paper_width_mm: u32,
  pub cut: bool,
  /// "auto" (thermal printers get ESC/POS, others normal Windows printing),
  /// "escpos" or "windows"
  pub print_mode: String,
  pub receipt_width_mm: f64,
  pub admin: Option<Admin>,
}

impl Default for Config {
  fn default() -> Self {
    Config {
      printer_name: String::new(),
      paper_width_mm: 58,
      cut: true,
      print_mode: "auto".into(),
      receipt_width_mm: 72.0,
      admin: None,
    }
  }
}

pub struct Store {
  pub dir: PathBuf,
}

const RECEIPT_FIELDS: [&str; 6] = ["receiptNo", "date", "inTime", "outTime", "fee", "feeText"];

impl Store {
  pub fn new(dir: PathBuf) -> Self {
    let _ = fs::create_dir_all(dir.join("data"));
    Store { dir }
  }

  fn config_file(&self) -> PathBuf {
    self.dir.join("config.json")
  }

  fn receipts_file(&self) -> PathBuf {
    self.dir.join("data").join("receipts.json")
  }

  pub fn log(&self, message: &str) {
    let line = format!("{}  {}\r\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), message);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(self.dir.join("app.log")) {
      let _ = f.write_all(line.as_bytes());
    }
  }

  pub fn config(&self) -> Config {
    read_json(&self.config_file()).unwrap_or_default()
  }

  pub fn save_config(&self, config: &Config) -> Result<(), String> {
    write_json(&self.config_file(), config)
  }

  pub fn receipts(&self) -> Vec<Map<String, Value>> {
    match read_json::<Value>(&self.receipts_file()) {
      Some(Value::Array(items)) => items
        .into_iter()
        .filter_map(|v| match v {
          Value::Object(m) => Some(m),
          _ => None,
        })
        .collect(),
      Some(Value::Object(m)) => vec![m],
      _ => Vec::new(),
    }
  }

  /// Adds the receipt (or updates the one with the same number) and, when it
  /// was printed, counts the print.
  pub fn save_receipt(&self, data: &Map<String, Value>, printed: bool) -> Result<Map<String, Value>, String> {
    let receipt_no = data.get("receiptNo").and_then(Value::as_str).unwrap_or("");
    if receipt_no.is_empty() {
      return Err("receiptNo is required".into());
    }

    let mut list = self.receipts();
    let index = match list.iter().position(|r| r.get("receiptNo").and_then(Value::as_str) == Some(receipt_no)) {
      Some(i) => {
        for f in RECEIPT_FIELDS {
          if let Some(v) = data.get(f).filter(|v| !v.is_null()) {
            list[i].insert(f.into(), v.clone());
          }
        }
        i
      }
      None => {
        let mut r = Map::new();
        for f in RECEIPT_FIELDS {
          r.insert(f.into(), data.get(f).cloned().unwrap_or(Value::Null));
        }
        r.insert("createdAt".into(), iso_now().into());
        r.insert("printCount".into(), 0.into());
        list.push(r);
        list.len() - 1
      }
    };

    if printed {
      let count = list[index].get("printCount").and_then(Value::as_u64).unwrap_or(0);
      list[index].insert("printCount".into(), (count + 1).into());
      list[index].insert("lastPrintedAt".into(), iso_now().into());
    }

    write_json(&self.receipts_file(), &list)?;
    Ok(list[index].clone())
  }

  /// First start only: take over the printer, admin login and receipts of the
  /// browser print service if it is installed on this PC.
  pub fn import_print_service(&self) {
    if self.config_file().exists() {
      return;
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let old = PathBuf::from(local).join("ParkingPrintService");

    if let Some(config) = read_json::<Config>(&old.join("config.json")) {
      if self.save_config(&config).is_ok() {
        self.log("Imported settings from the print service");
      }
    }
    let old_receipts = old.join("data").join("receipts.json");
    if old_receipts.exists() && !self.receipts_file().exists() {
      if fs::copy(&old_receipts, self.receipts_file()).is_ok() {
        self.log("Imported receipts from the print service");
      }
    }
  }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
  let text = fs::read_to_string(path).ok()?;
  // PowerShell may have written a UTF-8 BOM
  let text = text.trim_start_matches('\u{feff}');
  if text.trim().is_empty() {
    return None;
  }
  serde_json::from_str(text).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
  let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
  let tmp = path.with_extension("json.tmp");
  fs::write(&tmp, json).map_err(|e| e.to_string())?;
  fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn iso_now() -> String {
  chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// --- Passwords: PBKDF2-HMAC-SHA1, 100000 rounds (same as the print service) ---

pub fn random_hex(len: usize) -> String {
  let mut bytes = vec![0u8; len];
  getrandom::fill(&mut bytes).expect("random number generator unavailable");
  to_hex(&bytes)
}

fn to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
  if hex.len() % 2 != 0 {
    return None;
  }
  (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}

fn hash_password(password: &str, salt: &[u8]) -> String {
  let mut out = [0u8; 32];
  pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), salt, 100_000, &mut out);
  to_hex(&out)
}

pub fn new_admin(username: &str, password: &str) -> Admin {
  let salt = random_hex(16);
  let hash = hash_password(password, &from_hex(&salt).unwrap());
  Admin { username: username.into(), salt, hash }
}

pub fn check_password(password: &str, admin: &Admin) -> bool {
  let Some(salt) = from_hex(&admin.salt) else { return false };
  let candidate = hash_password(password, &salt);
  let expected = admin.hash.to_ascii_uppercase();
  // constant-time compare
  candidate.len() == expected.len()
    && candidate.bytes().zip(expected.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn password_hash_matches_print_service() {
    // Hash created by the PowerShell print service (Rfc2898DeriveBytes)
    let admin = Admin {
      username: "admin".into(),
      salt: "00112233445566778899AABBCCDDEEFF".into(),
      hash: "6F54FA43585814113A8676870AE29DA4C583C911499044FB03E2F203A6EFC7FC".into(),
    };
    assert!(check_password("secret1", &admin));
    assert!(!check_password("secret2", &admin));
    assert!(check_password("pass123", &new_admin("x", "pass123")));
  }

  #[test]
  fn saves_and_counts_prints() {
    let dir = std::env::temp_dir().join(format!("pm-test-{}", random_hex(4)));
    let store = Store::new(dir.clone());
    let receipt: Map<String, Value> = serde_json::from_str(
      r#"{"receiptNo":"PK-1","date":"14 Oct 2026","inTime":"08:00 AM","outTime":"09:00 AM","fee":89,"feeText":"89.00 ETB"}"#,
    )
    .unwrap();
    store.save_receipt(&receipt, false).unwrap();
    store.save_receipt(&receipt, true).unwrap();
    let saved = store.save_receipt(&receipt, true).unwrap();
    assert_eq!(saved["printCount"], 2);
    assert_eq!(store.receipts().len(), 1);
    assert!(saved["createdAt"].as_str().unwrap().ends_with('Z'));
    let _ = fs::remove_dir_all(dir);
  }
}
