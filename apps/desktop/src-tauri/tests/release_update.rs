//! Opt-in smoke test against the real public GitHub Release; never installs or restarts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

#[tokio::test]
#[ignore = "downloads the public Windows installer; run explicitly after publishing"]
async fn public_release_download_passes_the_shipped_public_key() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let updater_config = &config["plugins"]["updater"];
    let mut context = mock_context(noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), updater_config.clone());
    // Simulate an older installed client, keeping its normal version comparison.
    context.package_info_mut().version = "0.1.0".parse().unwrap();
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let endpoint = updater_config["endpoints"][0]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .unwrap()
        .target("windows-x86_64")
        .timeout(Duration::from_secs(90))
        .build()
        .unwrap()
        .check()
        .await
        .unwrap()
        .expect("a release newer than 0.1.0");
    assert!(
        update
            .download_url
            .as_str()
            .starts_with("https://github.com/liulewis67-ops/Nivlo/releases/download/")
    );
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .expect("real release must pass Tauri signature verification");
    assert!(bytes.starts_with(b"MZ"), "expected a Windows installer");
    println!(
        "Verified GitHub Release {}: {} signed bytes; installation skipped",
        update.version,
        bytes.len()
    );
}
