//! NVDA controller client (LGPL-2.1, shipped unmodified as a separate DLL),
//! loaded at runtime. Looks next to the exe first, then in the repo's
//! native/vendor copy during development.

use std::path::PathBuf;
use std::sync::OnceLock;

use libloading::{Library, Symbol};

pub enum Outcome {
    Spoken,
    NotRunning,
    NoController,
    Error(u32),
}

type NoArgs = unsafe extern "system" fn() -> u32;
type Speak = unsafe extern "system" fn(*const u16) -> u32;

const DLL: &str = "nvdaControllerClient.dll";

fn candidates() -> Vec<PathBuf> {
    let mut out = vec![];
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        out.push(dir.join(DLL));
        out.push(dir.join("nvda").join(DLL));
        // Dev: native/target/<profile>/ → repo root.
        let mut up = dir.clone();
        for _ in 0..4 {
            out.push(up.join("native").join("vendor").join("nvda").join("x64").join(DLL));
            if !up.pop() {
                break;
            }
        }
    }
    out
}

fn library() -> Option<&'static Library> {
    static LIB: OnceLock<Option<Library>> = OnceLock::new();
    LIB.get_or_init(|| {
        candidates().into_iter().filter(|p| p.is_file()).find_map(|p| {
            // SAFETY: loading the vendored NVDA controller client, whose init has no side effects.
            match unsafe { Library::new(&p) } {
                Ok(lib) => {
                    tracing::debug!("nvda controller loaded from {}", p.display());
                    Some(lib)
                }
                Err(e) => {
                    tracing::warn!("cannot load {}: {e}", p.display());
                    None
                }
            }
        })
    })
    .as_ref()
}

pub fn speak(text: &str, assertive: bool) -> Outcome {
    let Some(lib) = library() else { return Outcome::NoController };
    // SAFETY: symbol signatures match nvdaControllerClient's exported C API.
    unsafe {
        let (Ok(test), Ok(cancel), Ok(say)) = (
            lib.get::<NoArgs>(b"nvdaController_testIfRunning\0"),
            lib.get::<NoArgs>(b"nvdaController_cancelSpeech\0"),
            lib.get::<Speak>(b"nvdaController_speakText\0"),
        ) else {
            return Outcome::NoController;
        };
        let (test, cancel, say): (Symbol<NoArgs>, Symbol<NoArgs>, Symbol<Speak>) = (test, cancel, say);
        if test() != 0 {
            return Outcome::NotRunning;
        }
        if assertive {
            cancel();
        }
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        match say(wide.as_ptr()) {
            0 => Outcome::Spoken,
            rc => Outcome::Error(rc),
        }
    }
}
