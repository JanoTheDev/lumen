//! Embeds the application manifest (PerMonitorV2, asInvoker, uiAccess) and a
//! version resource. The `uiaccess` feature flips uiAccess to true.

use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=lumen-native.manifest");
    println!("cargo:rerun-if-changed=lumen-native.rc");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION");
    let parts: Vec<&str> = version.split(['.', '-', '+']).collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("0");
    let ui_access = if env::var_os("CARGO_FEATURE_UIACCESS").is_some() { "true" } else { "false" };

    let manifest = fs::read_to_string("lumen-native.manifest")
        .expect("read manifest")
        .replace("@VERSION@", &format!("{}.{}.{}.0", part(0), part(1), part(2)))
        .replace("@UIACCESS@", ui_access);
    let manifest_path = out.join("lumen-native.manifest");
    fs::write(&manifest_path, manifest).expect("write manifest");

    let rc = fs::read_to_string("lumen-native.rc")
        .expect("read rc")
        .replace("@MANIFEST@", &manifest_path.display().to_string().replace('\\', "\\\\"))
        .replace("@VERSION@", &version)
        .replace("@V1@", part(0))
        .replace("@V2@", part(1))
        .replace("@V3@", part(2));
    let rc_path = out.join("lumen-native.rc");
    fs::write(&rc_path, rc).expect("write rc");

    embed_resource::compile(&rc_path, embed_resource::NONE).manifest_required().expect("embed resources");
}
