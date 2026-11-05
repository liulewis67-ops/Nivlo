//! 备份与恢复的测试：备份 → 清空 → 恢复后数据完全一致；坏备份被拒绝且不留痕迹。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;

use chrono::{TimeZone, Utc};
use nivlo_application::ports::{ItemFilter, UnitOfWork};
use nivlo_common::paths::AppPaths;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{Item, ItemType, NewItem};
use nivlo_storage::Database;
use uuid::Uuid;

use super::{
    BACKUP_FORMAT, BACKUP_VERSION, BackupError, Manifest, apply_pending_reset,
    apply_pending_restore, create_backup, has_pending_reset, has_pending_restore, stage_reset,
    stage_restore,
};

/// 临时数据目录 + 已迁移的数据库。
async fn fixture() -> (tempfile::TempDir, AppPaths, Database) {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(dir.path());
    paths.ensure_dirs().unwrap();
    let database = Database::open(&paths.database_file()).await.unwrap();
    database.migrate().await.unwrap();
    (dir, paths, database)
}

/// 随备份验证的界面偏好（key、值）。
const UI_PREFS: [(&str, &str); 4] = [
    ("ui.appearance", r#"{"accent":"rose"}"#),
    ("ui.skin", r#"{"frames":[],"fps":6}"#),
    ("ui.language", "en"),
    ("ui.theme", "dark"),
];

/// 固定的测试时间。
fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 11, 8, 0, 0).unwrap()
}

fn item(n: u128, title: &str) -> Item {
    Item::create(
        ItemId::from_uuid(Uuid::from_u128(n)),
        NewItem::new(ItemType::Note, title),
        Utc.with_ymd_and_hms(2026, 10, 11, 8, 0, 0).unwrap(),
    )
    .unwrap()
    .0
}

/// 取出全部 Item 的 (ID, 标题)，排序后便于比较。
async fn titles(database: &Database) -> Vec<(String, String)> {
    let mut tx = database.begin().await.unwrap();
    let filter = ItemFilter {
        include_archived: true,
        ..ItemFilter::default()
    };
    let mut all: Vec<_> = tx
        .items()
        .list(&filter)
        .await
        .unwrap()
        .iter()
        .map(|i| (i.id().to_string(), i.title().as_str().to_owned()))
        .collect();
    all.sort();
    all
}

#[tokio::test]
async fn backup_then_wipe_then_restore_gives_back_identical_data() {
    let (_dir, paths, database) = fixture().await;
    {
        let mut tx = database.begin().await.unwrap();
        tx.items().insert(&item(1, "买牛奶")).await.unwrap();
        tx.items().insert(&item(2, "读书笔记")).await.unwrap();
        // 外观与皮肤存于 settings 表（D-14），应随备份一起带走。
        for (key, value) in UI_PREFS {
            tx.settings().set(key, value, now()).await.unwrap();
        }
        tx.commit().await.unwrap();
    }
    std::fs::write(paths.attachments_dir().join("shot.png"), b"PNG-BYTES").unwrap();
    let before = titles(&database).await;

    let backup = create_backup(
        &database,
        &paths,
        "nivlo-backup-test.zip",
        "2026-10-11T08:00:00Z",
        "0.1.0",
    )
    .await
    .unwrap();
    assert!(backup.is_file());
    // 临时快照不留下。
    assert!(
        !paths
            .exports_dir()
            .join(".nivlo-backup-test.zip.snapshot.db")
            .exists()
    );

    // 清空：删数据、删附件。
    {
        let mut tx = database.begin().await.unwrap();
        tx.items()
            .delete(ItemId::from_uuid(Uuid::from_u128(1)))
            .await
            .unwrap();
        tx.items()
            .delete(ItemId::from_uuid(Uuid::from_u128(2)))
            .await
            .unwrap();
        for (key, _) in UI_PREFS {
            tx.settings()
                .set(key, "changed-after-backup", now())
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }
    std::fs::remove_file(paths.attachments_dir().join("shot.png")).unwrap();
    assert!(titles(&database).await.is_empty());

    // 恢复：先暂存，关闭数据库后（模拟重启）应用。
    let manifest = stage_restore(&backup, &paths).await.unwrap();
    assert_eq!(manifest.format, BACKUP_FORMAT);
    assert!(has_pending_restore(&paths));
    database.close().await;
    assert!(apply_pending_restore(&paths, "20261011-080000").unwrap());
    assert!(!has_pending_restore(&paths));

    let restored = Database::open(&paths.database_file()).await.unwrap();
    restored.migrate().await.unwrap();
    assert_eq!(titles(&restored).await, before);
    {
        let mut tx = restored.begin().await.unwrap();
        for (key, value) in UI_PREFS {
            assert_eq!(
                tx.settings().get(key).await.unwrap().as_deref(),
                Some(value)
            );
        }
    }
    assert_eq!(
        std::fs::read(paths.attachments_dir().join("shot.png")).unwrap(),
        b"PNG-BYTES"
    );
    // 被替换掉的当前数据没有删除，还能找回。
    assert!(
        paths
            .root()
            .join("replaced-20261011-080000")
            .join("nivlo.db")
            .is_file()
    );
    restored.close().await;
}

#[tokio::test]
async fn nothing_pending_means_nothing_happens() {
    let (_dir, paths, database) = fixture().await;
    database.close().await;
    assert!(!apply_pending_restore(&paths, "x").unwrap());
    assert!(!apply_pending_reset(&paths, "x").unwrap());
}

#[tokio::test]
async fn reset_starts_empty_and_keeps_old_data_aside() {
    let (_dir, paths, database) = fixture().await;
    {
        let mut tx = database.begin().await.unwrap();
        tx.items().insert(&item(1, "keep me")).await.unwrap();
        tx.commit().await.unwrap();
    }
    std::fs::write(paths.attachments_dir().join("shot.png"), b"PNG").unwrap();

    stage_reset(&paths).unwrap();
    assert!(has_pending_reset(&paths));
    database.close().await;
    // sqlx 在后台线程上真正关闭 SQLite 连接，close() 返回后 Windows 上文件可能还被占用片刻。
    // 真实场景里清空发生在下次启动、数据库打开之前，不存在这个竞争。
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(apply_pending_reset(&paths, "20261106-080000").unwrap());
    assert!(!has_pending_reset(&paths));

    // 新库是空的，附件目录还在但是空的。
    let fresh = Database::open(&paths.database_file()).await.unwrap();
    fresh.migrate().await.unwrap();
    assert!(titles(&fresh).await.is_empty());
    assert_eq!(
        std::fs::read_dir(paths.attachments_dir()).unwrap().count(),
        0
    );
    fresh.close().await;

    // 旧数据没有删除，挪到了 replaced- 目录，能完整打开。
    let aside = paths.root().join("replaced-20261106-080000");
    assert_eq!(
        std::fs::read(aside.join("attachments").join("shot.png")).unwrap(),
        b"PNG"
    );
    let old = Database::open(&aside.join("nivlo.db")).await.unwrap();
    assert_eq!(titles(&old).await.len(), 1);
    old.close().await;
}

#[tokio::test]
async fn the_last_choice_between_restore_and_reset_wins() {
    let (dir, paths, database) = fixture().await;
    let backup = create_backup(&database, &paths, "b.zip", "2026-11-06T08:00:00Z", "0.1.0")
        .await
        .unwrap();
    // 先恢复后清空：恢复被取消。
    stage_restore(&backup, &paths).await.unwrap();
    stage_reset(&paths).unwrap();
    assert!(!has_pending_restore(&paths));
    assert!(has_pending_reset(&paths));
    // 先清空后恢复：清空被取消。
    stage_restore(&backup, &paths).await.unwrap();
    assert!(has_pending_restore(&paths));
    assert!(!has_pending_reset(&paths));
    database.close().await;
    drop(dir);
}

/// 写一个 zip，条目为 (名称, 内容)。
fn write_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
    let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

fn manifest_json(schema_version: i64) -> Vec<u8> {
    serde_json::to_vec(&Manifest {
        format: BACKUP_FORMAT.to_owned(),
        version: BACKUP_VERSION,
        created_at: "2026-10-11T08:00:00Z".into(),
        app_version: "0.1.0".into(),
        schema_version,
    })
    .unwrap()
}

#[tokio::test]
async fn bad_backups_are_rejected_and_leave_no_staging_data_behind() {
    let (dir, paths, database) = fixture().await;
    let good_db = {
        let snapshot = dir.path().join("good.db");
        database.snapshot_to(&snapshot).await.unwrap();
        std::fs::read(snapshot).unwrap()
    };
    let backup = dir.path().join("bad.zip");

    #[allow(clippy::type_complexity)]
    let cases: Vec<(&str, Vec<(&str, Vec<u8>)>)> = vec![
        ("缺少 manifest", vec![("nivlo.db", good_db.clone())]),
        (
            "路径穿越",
            vec![
                ("manifest.json", manifest_json(6)),
                ("nivlo.db", good_db.clone()),
                ("../evil.txt", b"x".to_vec()),
            ],
        ),
        (
            "不允许的文件",
            vec![
                ("manifest.json", manifest_json(6)),
                ("nivlo.db", good_db.clone()),
                ("settings/secrets.json", b"{}".to_vec()),
            ],
        ),
        ("缺少数据库", vec![("manifest.json", manifest_json(6))]),
        (
            "数据库损坏",
            vec![
                ("manifest.json", manifest_json(6)),
                ("nivlo.db", b"definitely not a sqlite database file.....".to_vec()),
            ],
        ),
        (
            "格式不对",
            vec![
                ("manifest.json", b"{\"format\":\"other\",\"version\":1,\"createdAt\":\"\",\"appVersion\":\"\",\"schemaVersion\":1}".to_vec()),
                ("nivlo.db", good_db.clone()),
            ],
        ),
    ];
    for (label, entries) in cases {
        let borrowed: Vec<(&str, &[u8])> =
            entries.iter().map(|(n, b)| (*n, b.as_slice())).collect();
        write_zip(&backup, &borrowed);
        let result = stage_restore(&backup, &paths).await;
        assert!(
            matches!(result, Err(BackupError::Invalid(_))),
            "{label}：{result:?}"
        );
        assert!(!has_pending_restore(&paths), "{label}");
        assert!(!paths.root().join("restore-staging").exists(), "{label}");
    }
    assert!(!dir.path().join("evil.txt").exists());
    database.close().await;
}

#[tokio::test]
async fn backups_from_a_newer_app_are_refused() {
    let (dir, paths, database) = fixture().await;
    // 造一个 Schema 版本比本程序新的库。
    let newer = dir.path().join("newer.db");
    database.snapshot_to(&newer).await.unwrap();
    {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", newer.display()))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (9999, 'future', 1, x'00', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }
    let backup = dir.path().join("future.zip");
    let db_bytes = std::fs::read(&newer).unwrap();
    write_zip(
        &backup,
        &[
            ("manifest.json", &manifest_json(9999)),
            ("nivlo.db", &db_bytes),
        ],
    );
    let result = stage_restore(&backup, &paths).await;
    assert!(
        matches!(result, Err(BackupError::Invalid(ref m)) if m.contains("更新版本")),
        "{result:?}"
    );
    assert!(!has_pending_restore(&paths));
    database.close().await;
}
