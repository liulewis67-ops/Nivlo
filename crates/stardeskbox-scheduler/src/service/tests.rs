//! Scheduler 的场景测试：FakeClock + 内存 Fake，不依赖真实时间与通知。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use stardeskbox_application::item::{ItemService, Patch, UpdateItemInput};
use stardeskbox_application::testing::{FakeUnitOfWork, RecordingPublisher};
use stardeskbox_application::trash::TrashService;
use stardeskbox_common::clock::FakeClock;
use stardeskbox_domain::id::ItemId;
use stardeskbox_domain::item::{DatePoint, ItemType, NewItem};
use stardeskbox_platform::error::PlatformError;
use stardeskbox_platform::notification::{Notification, NotificationPort};

use super::{Control, Scheduler};

/// 记录收到的通知的假通知出口。
#[derive(Default)]
struct FakeNotifier {
    sent: Mutex<Vec<Notification>>,
    fail: Mutex<bool>,
}

impl FakeNotifier {
    /// 已发送的通知。
    fn sent(&self) -> Vec<Notification> {
        self.sent.lock().unwrap().clone()
    }

    /// 让之后的发送失败。
    fn fail_sends(&self) {
        *self.fail.lock().unwrap() = true;
    }
}

impl NotificationPort for FakeNotifier {
    fn notify(&self, notification: &Notification) -> Result<(), PlatformError> {
        if *self.fail.lock().unwrap() {
            return Err(PlatformError::Failed("通知被系统拒绝".to_owned()));
        }
        self.sent.lock().unwrap().push(notification.clone());
        Ok(())
    }
}

/// 测试夹具。
struct Fixture {
    scheduler: Scheduler,
    items: ItemService,
    trash: TrashService,
    notifier: Arc<FakeNotifier>,
    control: Arc<Control>,
    clock: FakeClock,
    uow: FakeUnitOfWork,
}

/// 2026-10-14（周三）的某个 UTC 时刻。
fn at(hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, hour, minute, 0).unwrap()
}

/// 构造夹具；时钟在 09:00 UTC。
fn fixture_in(timezone: Tz) -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = FakeClock::new(at(9, 0), timezone);
    let notifier = Arc::new(FakeNotifier::default());
    let control = Arc::new(Control::new());
    let events = Arc::new(RecordingPublisher::new());
    Fixture {
        scheduler: Scheduler::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            notifier.clone(),
            control.clone(),
        ),
        items: ItemService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        trash: TrashService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events,
            Arc::new(stardeskbox_application::testing::FakeAttachmentFiles::new()),
        ),
        notifier,
        control,
        clock,
        uow,
    }
}

/// 构造夹具（UTC）。
fn fixture() -> Fixture {
    fixture_in(Tz::UTC)
}

/// 创建一个带提醒的待办。
async fn reminder(f: &Fixture, title: &str, when: DateTime<Utc>) -> ItemId {
    let mut new = NewItem::new(ItemType::Todo, title);
    new.reminder_at = Some(when);
    f.items.create_item(new).await.unwrap().id()
}

/// 用同一份数据另起一个 Scheduler（模拟应用重启）。
fn restarted(f: &Fixture) -> Scheduler {
    Scheduler::new(
        Arc::new(f.uow.clone()),
        Arc::new(f.clock.clone()),
        f.notifier.clone(),
        Arc::new(Control::new()),
    )
}

#[tokio::test]
async fn a_reminder_fires_once_when_it_comes_due() {
    let f = fixture();
    reminder(&f, "交周报", at(10, 0)).await;

    // 还没到点：不通知，并报告下一个触发点。
    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(10, 0)));
    assert!(f.notifier.sent().is_empty());

    f.clock.set(at(10, 0));
    assert_eq!(f.scheduler.reconcile().await.unwrap(), None);
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].title, "提醒");
    assert_eq!(sent[0].body, "交周报");
    assert!(sent[0].item_id.is_some());

    // 再核对多少次都不重复。
    f.clock.set(at(10, 30));
    f.scheduler.reconcile().await.unwrap();
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1);
}

#[tokio::test]
async fn a_reminder_repeats_at_one_minute_intervals_up_to_the_configured_count() {
    let f = fixture();
    f.control.set_repeat_count(3);
    reminder(&f, "交周报", at(10, 0)).await;
    for (minute, count, next) in [(0, 1, Some(1)), (1, 2, Some(2)), (2, 3, None), (3, 3, None)] {
        f.clock.set(at(10, minute));
        assert_eq!(
            f.scheduler.reconcile().await.unwrap(),
            next.map(|m| at(10, m))
        );
        // 无论同一时刻唤醒几次，间隔内都只发一条。
        f.scheduler.reconcile().await.unwrap();
        assert_eq!(f.notifier.sent().len(), count);
    }
}

#[tokio::test]
async fn paused_repeats_do_not_send_and_removing_the_trigger_cancels_the_repeat() {
    let f = fixture();
    f.control.set_repeat_count(3);
    let id = reminder(&f, "交周报", at(10, 0)).await;
    f.clock.set(at(10, 0));
    f.scheduler.reconcile().await.unwrap();

    f.control.set_paused(true);
    f.clock.set(at(10, 1));
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1);

    f.items
        .update_item(
            id,
            UpdateItemInput {
                reminder_at: Patch::Set(at(10, 10)),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();
    f.control.set_paused(false);
    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(10, 10)));
    assert_eq!(f.notifier.sent().len(), 1);
}

#[tokio::test]
async fn the_nearest_trigger_is_reported_and_several_can_share_a_moment() {
    let f = fixture();
    reminder(&f, "甲", at(11, 0)).await;
    reminder(&f, "乙", at(10, 0)).await;
    reminder(&f, "丙", at(10, 0)).await;
    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(10, 0)));

    f.clock.set(at(10, 0));
    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(11, 0)));
    assert_eq!(f.notifier.sent().len(), 2);
}

#[tokio::test]
async fn changing_a_reminder_reschedules_it_and_clearing_it_cancels() {
    let f = fixture();
    let id = reminder(&f, "改期的提醒", at(10, 0)).await;
    f.items
        .update_item(
            id,
            UpdateItemInput {
                reminder_at: Patch::Set(at(12, 0)),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();
    f.clock.set(at(10, 30));
    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(12, 0)));
    assert!(f.notifier.sent().is_empty(), "旧的提醒时间不再有效");

    f.items
        .update_item(
            id,
            UpdateItemInput {
                reminder_at: Patch::Clear,
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();
    f.clock.set(at(12, 30));
    assert_eq!(f.scheduler.reconcile().await.unwrap(), None);
    assert!(f.notifier.sent().is_empty());
}

#[tokio::test]
async fn a_reminder_that_was_slept_through_is_sent_once_as_missed() {
    // 10:00 的提醒，09:50 休眠，11:00 恢复。
    let f = fixture();
    reminder(&f, "开会", at(10, 0)).await;
    f.clock.set(at(9, 50));
    f.scheduler.reconcile().await.unwrap();
    assert!(f.notifier.sent().is_empty());

    f.clock.set(at(11, 0));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].title, "错过的提醒");
    assert_eq!(sent[0].body, "10:00 开会");

    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1, "只通知一次");
}

#[tokio::test]
async fn many_missed_reminders_become_a_single_summary() {
    let f = fixture();
    for n in 1..=5 {
        reminder(&f, &format!("事项{n}"), at(8, 30 + n)).await;
    }
    f.clock.set(at(9, 0));
    // 创建时都在未来（09:00 之后）才对；这里把时钟直接设到更晚，模拟睡了很久。
    f.clock.set(at(13, 0));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].title, "你错过了 5 个提醒");
}

#[tokio::test]
async fn a_restart_never_repeats_what_was_already_sent_but_catches_up_on_the_rest() {
    let f = fixture();
    reminder(&f, "已经通知过", at(10, 0)).await;
    f.clock.set(at(10, 0));
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1);

    // 应用退出期间又有一个提醒到点了。
    reminder(&f, "退出期间到点", at(10, 20)).await;
    f.clock.set(at(10, 40));
    let second = restarted(&f);
    second.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1].body, "10:20 退出期间到点");
}

#[tokio::test]
async fn moving_the_clock_forward_fires_and_moving_it_back_never_repeats() {
    let f = fixture();
    reminder(&f, "时钟测试", at(10, 0)).await;
    // 系统时间向前调整了几个小时。
    f.clock.set(at(14, 0));
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1);

    // 又被调回到触发点之前，随后再次走过它：不重复。
    f.clock.set(at(9, 30));
    f.scheduler.reconcile().await.unwrap();
    f.clock.set(at(10, 30));
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 1);
}

#[tokio::test]
async fn paused_notifications_are_held_and_summarized_on_resume() {
    let f = fixture();
    reminder(&f, "暂停期间到点", at(10, 0)).await;
    f.control.set_paused(true);
    f.clock.set(at(10, 30));
    f.scheduler.reconcile().await.unwrap();
    assert!(f.notifier.sent().is_empty(), "暂停期间不弹出通知");

    f.control.set_paused(false);
    f.clock.set(at(11, 0));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1, "恢复后补发，没有丢失");
    assert_eq!(sent[0].title, "错过的提醒");

    // 暂停期间攒下很多：恢复后合并成一条汇总。
    f.control.set_paused(true);
    for n in 1..=4 {
        reminder(&f, &format!("攒下的{n}"), at(11, 10 + n)).await;
    }
    f.clock.set(at(12, 0));
    f.scheduler.reconcile().await.unwrap();
    f.control.set_paused(false);
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().last().unwrap().title, "你错过了 4 个提醒");
}

#[tokio::test]
async fn completed_archived_and_deleted_items_do_not_fire() {
    let f = fixture();
    let done = reminder(&f, "做完了", at(10, 0)).await;
    f.items.complete_item(done).await.unwrap();
    let trashed = reminder(&f, "删掉了", at(10, 0)).await;
    f.trash.delete(&[trashed]).await.unwrap();
    reminder(&f, "留着的", at(10, 0)).await;

    f.clock.set(at(10, 1));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].body, "留着的");
}

#[tokio::test]
async fn tips_with_a_time_fire_at_their_local_time() {
    // 东京 UTC+9：本地 2026-10-14 10:00 = UTC 01:00。
    let f = fixture_in(Tz::Asia__Tokyo);
    f.clock.set(at(0, 0));
    let mut new = NewItem::new(ItemType::Tip, "站会");
    new.scheduled = Some(DatePoint::at(
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap(),
        NaiveTime::from_hms_opt(10, 0, 0).unwrap(),
    ));
    f.items.create_item(new).await.unwrap();

    assert_eq!(f.scheduler.reconcile().await.unwrap(), Some(at(1, 0)));
    f.clock.set(at(1, 0));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent[0].title, "💡 提示");
    assert_eq!(sent[0].body, "10:00 站会");
}

#[tokio::test]
async fn todos_with_a_due_time_fire_when_due_but_date_only_deadlines_do_not() {
    let f = fixture();
    let mut with_time = NewItem::new(ItemType::Todo, "交报告");
    with_time.due = Some(DatePoint::at(
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap(),
        NaiveTime::from_hms_opt(17, 0, 0).unwrap(),
    ));
    f.items.create_item(with_time).await.unwrap();
    let mut date_only = NewItem::new(ItemType::Todo, "只有日期");
    date_only.due = Some(DatePoint::all_day(
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap(),
    ));
    f.items.create_item(date_only).await.unwrap();

    f.clock.set(at(17, 0));
    f.scheduler.reconcile().await.unwrap();
    let sent = f.notifier.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].title, "到期");
    assert_eq!(sent[0].body, "交报告");
}

#[tokio::test]
async fn a_failed_notification_is_not_retried_forever() {
    let f = fixture();
    reminder(&f, "系统拒绝通知", at(10, 0)).await;
    f.notifier.fail_sends();
    f.clock.set(at(10, 0));
    f.scheduler.reconcile().await.unwrap();
    // 之后即使通知恢复可用，也不会为这个已经「处理过」的触发点再弹一次。
    *f.notifier.fail.lock().unwrap() = false;
    f.scheduler.reconcile().await.unwrap();
    assert!(f.notifier.sent().is_empty());
}

#[tokio::test]
async fn a_commit_failure_records_nothing_so_the_next_run_retries() {
    let f = fixture();
    reminder(&f, "提交失败", at(10, 0)).await;
    f.clock.set(at(10, 0));
    f.uow.fail_next_commit();
    assert!(f.scheduler.reconcile().await.is_err());
    // 记录没有提交：下一次会再试（至多重复一次通知，绝不丢失）。
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 2);
    f.scheduler.reconcile().await.unwrap();
    assert_eq!(f.notifier.sent().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_loop_wakes_on_demand_and_exits_on_shutdown() {
    let f = fixture();
    reminder(&f, "被唤醒后触发", at(10, 0)).await;
    let scheduler = Arc::new(f.scheduler);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let runner = {
        let scheduler = scheduler.clone();
        tokio::spawn(async move {
            scheduler
                .run(async move {
                    let _ = stop_rx.await;
                })
                .await;
        })
    };
    tokio::time::sleep(StdDuration::from_millis(50)).await;
    assert!(f.notifier.sent().is_empty());

    // 时钟走过触发点，但计时器还没到：显式唤醒后立刻触发。
    f.clock.set(at(10, 0));
    f.control.wake();
    tokio::time::sleep(StdDuration::from_millis(50)).await;
    assert_eq!(f.notifier.sent().len(), 1);

    stop_tx.send(()).unwrap();
    tokio::time::timeout(StdDuration::from_secs(1), runner)
        .await
        .expect("Scheduler 应当在 shutdown 后退出")
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn the_loop_rechecks_on_its_own_even_without_a_wake() {
    let f = fixture();
    reminder(&f, "自己醒来", at(9, 5)).await;
    let scheduler = Arc::new(f.scheduler);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let runner = {
        let scheduler = scheduler.clone();
        tokio::spawn(async move {
            scheduler
                .run(async move {
                    let _ = stop_rx.await;
                })
                .await;
        })
    };
    tokio::time::sleep(StdDuration::from_millis(50)).await;
    assert!(f.notifier.sent().is_empty());

    // 墙上时钟走到触发点；循环的计时器（最长 15 分钟）到点后自己重新核对。
    f.clock.set(at(9, 6));
    tokio::time::sleep(StdDuration::from_secs(15 * 60 + 5)).await;
    assert_eq!(f.notifier.sent().len(), 1);

    stop_tx.send(()).unwrap();
    runner.await.unwrap();
}
