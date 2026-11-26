//! 全文搜索在真实 SQLite（FTS5 trigram）上的行为（实施计划 3.4、D-09）。

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "集成测试中失败即断言"
)]

use std::time::Instant;

use chrono::{DateTime, TimeZone, Utc};
use stardeskbox_application::ports::UnitOfWork;
use stardeskbox_domain::id::{ItemId, SourceId};
use stardeskbox_domain::item::{ContentFormat, Item, ItemType, NewItem};
use stardeskbox_domain::source::{Source, SourceType};
use stardeskbox_storage::Database;
use uuid::Uuid;

/// 在临时目录中创建并迁移好的数据库。
async fn new_db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("stardeskbox.db"))
        .await
        .unwrap();
    db.migrate().await.unwrap();
    (dir, db)
}

/// 固定的"现在"，按分钟递增。
fn t(minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap()
        + chrono::Duration::minutes(i64::from(minute))
}

/// 确定性的 ID。
fn id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 创建一个 Item。
fn item(n: u128, item_type: ItemType, title: &str, content: Option<&str>, minute: u32) -> Item {
    let mut new = NewItem::new(item_type, title);
    new.content = content.map(str::to_owned);
    new.content_format = ContentFormat::Plain;
    Item::create(id(n), new, t(minute)).unwrap().0
}

/// 在一个事务里搜索，返回标题列表。
async fn titles(db: &Database, query: &str) -> Vec<String> {
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .search(query, false, 50)
        .await
        .unwrap()
        .iter()
        .map(|i| i.title().as_str().to_owned())
        .collect()
}

#[tokio::test]
async fn chinese_substring_search_works_with_and_without_the_index() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Todo, "修复登录超时", None, 0))
        .await
        .unwrap();
    tx.items()
        .insert(&item(
            2,
            ItemType::Note,
            "周报",
            Some("本周完成了登录页的改版"),
            1,
        ))
        .await
        .unwrap();
    tx.items()
        .insert(&item(3, ItemType::Todo, "买牛奶", None, 2))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 2 个字符（trigram 无法匹配，走 LIKE 回退）：标题命中的排在前面。
    assert_eq!(titles(&db, "登录").await, ["修复登录超时", "周报"]);
    // 3 个字符以上走 FTS。
    assert_eq!(titles(&db, "登录超").await, ["修复登录超时"]);
    assert_eq!(titles(&db, "登录页的改版").await, ["周报"]);
    assert!(titles(&db, "不存在的词语").await.is_empty());
    assert!(titles(&db, "   ").await.is_empty());
}

#[tokio::test]
async fn open_items_rank_above_completed_ones_on_both_paths() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    // 已完成的那条更新、标题也更贴切，但仍然排在未完成的后面。
    let mut done = item(1, ItemType::Todo, "周报模板", None, 5);
    done.complete(t(6)).unwrap();
    tx.items().insert(&done).await.unwrap();
    tx.items()
        .insert(&item(2, ItemType::Todo, "写本周的周报模板草稿", None, 0))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // LIKE 回退（2 个字符）与 FTS（3 个字符以上）排序规则一致。
    assert_eq!(
        titles(&db, "周报").await,
        ["写本周的周报模板草稿", "周报模板"]
    );
    assert_eq!(
        titles(&db, "周报模板").await,
        ["写本周的周报模板草稿", "周报模板"]
    );
}

#[tokio::test]
async fn search_ignores_case_and_requires_every_word() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Todo, "Fix login timeout", None, 0))
        .await
        .unwrap();
    tx.items()
        .insert(&item(2, ItemType::Todo, "Fix payment bug", None, 1))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(titles(&db, "LOGIN").await, ["Fix login timeout"]);
    assert_eq!(titles(&db, "fix").await.len(), 2);
    assert_eq!(titles(&db, "fix timeout").await, ["Fix login timeout"]);
    // 短词被忽略，剩下的词照常匹配。
    assert_eq!(titles(&db, "a payment").await, ["Fix payment bug"]);
}

#[tokio::test]
async fn special_characters_in_the_query_are_literal() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Note, "折扣 50% off", None, 0))
        .await
        .unwrap();
    tx.items()
        .insert(&item(2, ItemType::Note, "snake_case 命名", None, 1))
        .await
        .unwrap();
    tx.items()
        .insert(&item(3, ItemType::Note, "他说\"你好\"", None, 2))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // LIKE 回退路径：% 与 _ 不是通配符。
    assert_eq!(titles(&db, "%").await, ["折扣 50% off"]);
    assert_eq!(titles(&db, "_c").await, ["snake_case 命名"]);
    // FTS 路径：引号、AND 之类的 FTS 语法被当作普通文字，不会报语法错误。
    assert_eq!(titles(&db, "\"你好\"").await, ["他说\"你好\""]);
    assert!(titles(&db, "snake OR NOT (").await.is_empty());
    assert!(titles(&db, "*** NEAR(").await.is_empty());
}

#[tokio::test]
async fn sources_are_searchable_and_archived_items_are_excluded() {
    let (_dir, db) = new_db().await;
    let mut archived = item(2, ItemType::Note, "旧笔记 local-first", None, 1);
    archived.archive(t(5)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Note, "读书笔记", None, 0))
        .await
        .unwrap();
    tx.items().insert(&archived).await.unwrap();
    tx.sources()
        .insert(&Source {
            id: SourceId::from_uuid(Uuid::from_u128(100)),
            item_id: id(1),
            source_type: SourceType::new("web"),
            source_app: Some("Chrome".into()),
            source_url: Some("https://example.com/blog/local-first-software".into()),
            source_path: None,
            original_title: Some("Local-first software".into()),
            metadata_json: None,
            captured_at: t(0),
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(titles(&db, "local-first").await, ["读书笔记"]);
    assert_eq!(titles(&db, "example.com/blog").await, ["读书笔记"]);
    // 归档的不出现在默认搜索里，但可以显式包含。
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.items()
            .search("local-first", true, 50)
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn the_index_follows_updates_and_deletes_in_the_same_transaction() {
    let (_dir, db) = new_db().await;
    let mut note = item(1, ItemType::Note, "草稿标题", Some("原来的正文内容"), 0);
    {
        let mut tx = db.begin().await.unwrap();
        tx.items().insert(&note).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert_eq!(titles(&db, "原来的正文").await, ["草稿标题"]);

    // 修改标题与正文：旧内容搜不到，新内容搜得到。
    note.rename("定稿标题", t(5)).unwrap();
    note.set_content(Some("全新的正文内容".into()), ContentFormat::Plain, t(5))
        .unwrap();
    {
        let mut tx = db.begin().await.unwrap();
        tx.items().update(&note).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert!(titles(&db, "原来的正文").await.is_empty());
    assert!(titles(&db, "草稿标题").await.is_empty());
    assert_eq!(titles(&db, "全新的正文").await, ["定稿标题"]);

    // 回滚的修改不影响索引。
    {
        let mut rolled = note.clone();
        rolled.rename("不会保存的标题", t(6)).unwrap();
        let mut tx = db.begin().await.unwrap();
        tx.items().update(&rolled).await.unwrap();
        tx.rollback().await.unwrap();
    }
    assert!(titles(&db, "不会保存").await.is_empty());
    assert_eq!(titles(&db, "定稿标题").await, ["定稿标题"]);

    // 删除后搜不到。
    {
        let mut tx = db.begin().await.unwrap();
        tx.items().delete(id(1)).await.unwrap();
        tx.commit().await.unwrap();
    }
    assert!(titles(&db, "全新的正文").await.is_empty());
}

#[tokio::test]
async fn results_are_limited() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for n in 0..30_u32 {
        tx.items()
            .insert(&item(
                u128::from(n) + 1,
                ItemType::Todo,
                &format!("任务 {n}"),
                None,
                n,
            ))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    assert_eq!(
        tx.items().search("任务", false, 10).await.unwrap().len(),
        10
    );
}

#[tokio::test]
async fn an_existing_database_is_indexed_by_the_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stardeskbox.db");
    // 模拟升级：先只应用到 0002，写入数据，再迁移到最新。
    {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::{ConnectOptions, Connection};
        let db = Database::open(&path).await.unwrap();
        db.migrate().await.unwrap();
        db.close().await;
        let mut conn = SqliteConnectOptions::new()
            .filename(&path)
            .connect()
            .await
            .unwrap();
        // 回到 0002 的状态：去掉搜索表与触发器、版本记录，然后插入一条「旧数据」。
        for sql in [
            "DROP TRIGGER items_fts_after_insert",
            "DROP TRIGGER items_fts_after_update",
            "DROP TRIGGER items_fts_after_delete",
            "DROP TRIGGER item_sources_fts_after_insert",
            "DROP TABLE items_fts",
            "DELETE FROM _sqlx_migrations WHERE version = 3",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO items (id, type, title, content, content_format, status, priority, created_at, updated_at)
             VALUES ('00000000-0000-7000-8000-000000000001', 'note', '升级前的笔记', '正文里有登录二字', 'plain', 'open', 'none',
                     '2026-10-09T08:00:00.000Z', '2026-10-09T08:00:00.000Z')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    assert_eq!(titles(&db, "登录二字").await, ["升级前的笔记"]);
}

#[tokio::test]
async fn searching_ten_thousand_items_is_fast() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for n in 0..10_000_u32 {
        let (title, body) = if n == 7_777 {
            (
                "修复登录超时".to_owned(),
                "用户反馈偶发的登录失败".to_owned(),
            )
        } else {
            (
                format!("普通待办 {n}"),
                format!("这是第 {n} 条用来填充数据库的内容，没有什么特别的"),
            )
        };
        tx.items()
            .insert(&item(
                u128::from(n) + 1,
                ItemType::Todo,
                &title,
                Some(&body),
                n % 1000,
            ))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    // 后三个是纯字母查询，会额外走拼音首字母：命中一条、命中全部（「普通待办」= ptdb）、全表扫描无命中。
    for query in ["登录超时", "登录", "第 7776 条", "xfdlcs", "ptdb", "zzqq"] {
        let started = Instant::now();
        let mut tx = db.begin().await.unwrap();
        let found = tx.items().search(query, false, 50).await.unwrap();
        let elapsed = started.elapsed();
        eprintln!("search {query:?}: {elapsed:?}, {} hits", found.len());
        assert_eq!(found.is_empty(), query == "zzqq", "{query}");
        // 目标是 < 50ms（实施计划 3.4）；留出 debug 构建与 CI 抖动的余量，只防止退化到量级错误。
        assert!(
            elapsed.as_millis() < 500,
            "{query}: {elapsed:?} for {} hits",
            found.len()
        );
    }
}

#[tokio::test]
async fn recently_opened_items_lead_the_recent_order() {
    use stardeskbox_application::ports::{ItemFilter, ItemOrder};

    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    for (n, title, minute) in [(1, "很早建的", 0), (2, "中间", 1), (3, "最新", 2)] {
        tx.items()
            .insert(&item(n, ItemType::Note, title, None, minute))
            .await
            .unwrap();
    }
    // 打开最早的那条：它排到最前；打开不存在的 ID 是空操作。
    tx.items().mark_opened(id(1), t(10)).await.unwrap();
    tx.items().mark_opened(id(99), t(11)).await.unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.begin().await.unwrap();
    let filter = ItemFilter {
        order: ItemOrder::RecentDesc,
        limit: Some(10),
        ..ItemFilter::default()
    };
    let recent: Vec<String> = tx
        .items()
        .list(&filter)
        .await
        .unwrap()
        .iter()
        .map(|i| i.title().as_str().to_owned())
        .collect();
    assert_eq!(recent, ["很早建的", "最新", "中间"]);
    // 打开不改「最近更新」的顺序。
    let filter = ItemFilter {
        order: ItemOrder::UpdatedDesc,
        ..filter
    };
    let updated: Vec<String> = tx
        .items()
        .list(&filter)
        .await
        .unwrap()
        .iter()
        .map(|i| i.title().as_str().to_owned())
        .collect();
    assert_eq!(updated, ["最新", "中间", "很早建的"]);
}

#[tokio::test]
async fn pinyin_initials_find_chinese_titles_after_regular_hits() {
    let (_dir, db) = new_db().await;
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Todo, "整理本周周报", None, 0))
        .await
        .unwrap();
    tx.items()
        .insert(&item(2, ItemType::Note, "bzzb 是什么缩写", None, 1))
        .await
        .unwrap();
    tx.items()
        .insert(&item(3, ItemType::Todo, "Grab a bag", None, 2))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 字面命中在前，拼音首字母命中接在后面。
    assert_eq!(
        titles(&db, "bzzb").await,
        ["bzzb 是什么缩写", "整理本周周报"]
    );
    // 不区分大小写；英文标题不参与首字母匹配（「Grab a bag」不会因为 ab 被误中）。
    assert_eq!(titles(&db, "ZLBZ").await, ["整理本周周报"]);
    assert!(titles(&db, "gab").await.is_empty());
    // 改标题后首字母跟着更新。
    let mut tx = db.begin().await.unwrap();
    let mut renamed = tx.items().get(id(1)).await.unwrap().unwrap();
    renamed.rename("准备季度复盘", t(5)).unwrap();
    tx.items().update(&renamed).await.unwrap();
    tx.commit().await.unwrap();
    assert!(titles(&db, "zlbz").await.is_empty());
    assert_eq!(titles(&db, "jdfp").await, ["准备季度复盘"]);
}

#[tokio::test]
async fn migrate_backfills_initials_for_rows_written_before_the_column_existed() {
    use sqlx::Connection;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stardeskbox.db");
    let db = Database::open(&path).await.unwrap();
    db.migrate().await.unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.items()
        .insert(&item(1, ItemType::Todo, "整理本周周报", None, 0))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // 模拟升级前的数据：这一列还没有值。
    let url = format!("sqlite:{}", path.display());
    let mut conn = sqlx::SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("UPDATE items SET title_initials = NULL")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    assert!(titles(&db, "bzzb").await.is_empty());

    db.migrate().await.unwrap();
    assert_eq!(titles(&db, "bzzb").await, ["整理本周周报"]);
}

#[tokio::test]
async fn brief_is_searchable_and_follows_edits() {
    let (_dir, db) = new_db().await;
    let mut new = NewItem::new(ItemType::Tip, "服务器维护");
    new.brief = Some("周六凌晨两点停机".to_owned());
    let (mut tip, _) = Item::create(id(1), new, t(0)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.items().insert(&tip).await.unwrap();
    tx.commit().await.unwrap();

    // 长词走 FTS，短词走 LIKE。
    assert_eq!(titles(&db, "凌晨两点").await, ["服务器维护"]);
    assert_eq!(titles(&db, "停机").await, ["服务器维护"]);

    tip.set_brief(Some("改到周日".to_owned()), t(1)).unwrap();
    let mut tx = db.begin().await.unwrap();
    tx.items().update(&tip).await.unwrap();
    tx.commit().await.unwrap();

    assert!(titles(&db, "凌晨两点").await.is_empty());
    assert_eq!(titles(&db, "改到周日").await, ["服务器维护"]);
}
