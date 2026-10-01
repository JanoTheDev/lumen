//! libvosk loaded at runtime (Apache-2.0). Shipped next to the exe with its
//! MinGW runtime DLLs; during development the Python venv's copy is used.

use std::ffi::{CStr, CString, c_char, c_float, c_int, c_short, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;

type ModelNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type FindWord = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type RecNewGrm = unsafe extern "C" fn(*mut c_void, c_float, *const c_char) -> *mut c_void;
type AcceptS = unsafe extern "C" fn(*mut c_void, *const c_short, c_int) -> c_int;
type ResultFn = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type VoidFn = unsafe extern "C" fn(*mut c_void);
type SetLogLevel = unsafe extern "C" fn(c_int);

pub struct Api {
    _lib: Library,
    model_new: ModelNew,
    find_word: FindWord,
    rec_new_grm: RecNewGrm,
    accept: AcceptS,
    result: ResultFn,
    partial: ResultFn,
    reset: VoidFn,
    rec_free: VoidFn,
}

const DLL: &str = "libvosk.dll";

fn candidates() -> Vec<PathBuf> {
    let mut out = vec![];
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        out.push(dir.join(DLL));
        out.push(dir.join("vosk").join(DLL));
        let mut up = dir.clone();
        for _ in 0..4 {
            out.push(up.join("agent").join(".venv").join("Lib").join("site-packages").join("vosk").join(DLL));
            if !up.pop() {
                break;
            }
        }
    }
    out
}

fn load(path: &Path) -> Result<Api, String> {
    use libloading::os::windows::{LOAD_WITH_ALTERED_SEARCH_PATH, Library as WinLib};
    // SAFETY: loading libvosk (and its sibling runtime DLLs via the altered search path);
    // symbol types match vosk_api.h.
    unsafe {
        let lib: Library = WinLib::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH)
            .map_err(|e| format!("cannot load {}: {e}", path.display()))?
            .into();
        macro_rules! sym {
            ($name:literal) => {
                *lib.get(concat!($name, "\0").as_bytes()).map_err(|e| format!("{}: {e}", $name))?
            };
        }
        let set_log: SetLogLevel = sym!("vosk_set_log_level");
        set_log(-1);
        Ok(Api {
            model_new: sym!("vosk_model_new"),
            find_word: sym!("vosk_model_find_word"),
            rec_new_grm: sym!("vosk_recognizer_new_grm"),
            accept: sym!("vosk_recognizer_accept_waveform_s"),
            result: sym!("vosk_recognizer_result"),
            partial: sym!("vosk_recognizer_partial_result"),
            reset: sym!("vosk_recognizer_reset"),
            rec_free: sym!("vosk_recognizer_free"),
            _lib: lib,
        })
    }
}

pub fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let found = candidates().into_iter().find(|p| p.is_file());
        match found {
            Some(p) => {
                let api = load(&p);
                if api.is_ok() {
                    tracing::info!("libvosk loaded from {}", p.display());
                }
                api
            }
            None => Err(format!("{DLL} not found next to lumen-native.exe")),
        }
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// A loaded model (never freed: models are cached for the process lifetime).
pub struct Model(*mut c_void);
// SAFETY: vosk models are immutable after load and documented as shareable across threads.
unsafe impl Send for Model {}
// SAFETY: see above.
unsafe impl Sync for Model {}

impl Model {
    pub fn load(api: &Api, path: &Path) -> Result<Model, String> {
        let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        // SAFETY: valid NUL-terminated path.
        let m = unsafe { (api.model_new)(c.as_ptr()) };
        if m.is_null() {
            Err(format!("failed to load the Vosk model at {}", path.display()))
        } else {
            Ok(Model(m))
        }
    }

    pub fn knows(&self, api: &Api, word: &str) -> bool {
        let Ok(c) = CString::new(word) else { return false };
        // SAFETY: live model, valid C string.
        unsafe { (api.find_word)(self.0, c.as_ptr()) >= 0 }
    }
}

pub struct Recognizer<'a> {
    api: &'a Api,
    ptr: *mut c_void,
}

impl<'a> Recognizer<'a> {
    pub fn new(api: &'a Api, model: &Model, grammar_json: &str) -> Result<Self, String> {
        let g = CString::new(grammar_json).map_err(|e| e.to_string())?;
        // SAFETY: live model, valid grammar string.
        let ptr = unsafe { (api.rec_new_grm)(model.0, 16000.0, g.as_ptr()) };
        if ptr.is_null() {
            Err("failed to create the Vosk recognizer".into())
        } else {
            Ok(Recognizer { api, ptr })
        }
    }

    /// Feeds samples; Some(final text) or None with the partial available via `partial()`.
    pub fn accept(&mut self, samples: &[i16]) -> bool {
        // SAFETY: live recognizer; slice length fits c_int for 250 ms blocks.
        unsafe { (self.api.accept)(self.ptr, samples.as_ptr(), samples.len() as c_int) == 1 }
    }

    fn json(&self, f: ResultFn, key: &str) -> String {
        // SAFETY: vosk returns a NUL-terminated JSON string owned by the recognizer.
        let raw = unsafe { CStr::from_ptr(f(self.ptr)) }.to_string_lossy().into_owned();
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get(key).and_then(|t| t.as_str()).map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn result(&self) -> String {
        self.json(self.api.result, "text")
    }

    pub fn partial(&self) -> String {
        self.json(self.api.partial, "partial")
    }

    pub fn reset(&mut self) {
        // SAFETY: live recognizer.
        unsafe { (self.api.reset)(self.ptr) }
    }
}

impl Drop for Recognizer<'_> {
    fn drop(&mut self) {
        // SAFETY: freeing the recognizer we created, once.
        unsafe { (self.api.rec_free)(self.ptr) }
    }
}
