fn main() {
    /* 16 KB pages, or Android runs the app in a compatibility mode and says so out loud.
     *
     * Android 15 moved to a 16 KB page size, and a shared library whose ELF LOAD segments are
     * aligned to the old 4 KB cannot be mapped directly. The emulator puts a dialog in front of
     * the app about it — "This app isn't 16 KB compatible" — before anything of ours is visible,
     * and Play now requires alignment outright for anything targeting 15 or later.
     *
     * NDK r28 and later emit this alignment by default. r27, which is what builds this today,
     * does not, so the flags are passed explicitly. Doing it here rather than in
     * .cargo/config.toml is deliberate: the Tauri CLI sets CARGO_TARGET_<triple>_RUSTFLAGS when
     * it invokes cargo, and that environment variable *replaces* the rustflags from a config
     * file rather than adding to them. A link arg emitted from a build script is additive and
     * survives, so this keeps working whichever way the build is started.
     */
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }

    tauri_build::build()
}
