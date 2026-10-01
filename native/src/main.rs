//! lumen-native: the Lumen OS sidecar. Speaks agent protocol v2 over stdio.

mod dpi;

fn main() {
    let awareness = dpi::init();
    eprintln!("lumen-native {} dpi awareness={awareness}", env!("CARGO_PKG_VERSION"));
    println!(
        "{{\"v\":2,\"event\":\"ready\",\"data\":{{\"impl\":\"native\",\"version\":\"{}\",\"capabilities\":[]}}}}",
        env!("CARGO_PKG_VERSION")
    );
}
