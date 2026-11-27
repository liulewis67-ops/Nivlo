//! 日期切换监视器的测试：暂停 Tokio 时间，并让 `FakeClock` 与虚拟时间一起推进。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use starat_common::clock::FakeClock;
use starat_domain::event::DomainEvent;
use tokio::sync::oneshot;

use super::run_day_change_watcher;
use crate::testing::RecordingPublisher;

/// 测试夹具。
struct Fixture {
    clock: FakeClock,
    events: Arc<RecordingPublisher>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

/// 启动监视器；时钟固定在上海 `hour:minute`（2026-10-09）。
fn start(hour: u32, minute: u32) -> Fixture {
    // 上海是 UTC+8：本地 hour:minute = UTC (hour - 8):minute；这里取当天的前一天 UTC 来避免负数。
    let now = Utc.with_ymd_and_hms(2026, 10, 9, 0, 0, 0).unwrap()
        + chrono::Duration::hours(i64::from(hour) - 8)
        + chrono::Duration::minutes(i64::from(minute));
    let clock = FakeClock::new(now, Tz::Asia__Shanghai);
    let events = Arc::new(RecordingPublisher::new());
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(run_day_change_watcher(
        Arc::new(clock.clone()),
        events.clone(),
        async move {
            let _ = stopped.await;
        },
    ));
    Fixture {
        clock,
        events,
        stop: Some(stop),
        task,
    }
}

/// 让 `FakeClock` 与 Tokio 虚拟时间同步推进，并让监视器有机会运行。
async fn tick(f: &Fixture, duration: Duration) {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    f.clock
        .advance(chrono::Duration::from_std(duration).unwrap());
    tokio::time::advance(duration).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

/// 构造日期。
fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

#[tokio::test(start_paused = true)]
async fn publishes_day_changed_exactly_when_local_midnight_passes() {
    let f = start(23, 59);

    tick(&f, Duration::from_secs(30)).await;
    assert!(f.events.events().is_empty(), "午夜之前不应发布");

    tick(&f, Duration::from_secs(31)).await;
    assert_eq!(
        f.events.events(),
        vec![DomainEvent::DayChanged { date: date(10, 10) }]
    );
}

#[tokio::test(start_paused = true)]
async fn publishes_one_event_per_day_across_several_days() {
    let f = start(23, 59);
    for day in 10..=12 {
        tick(&f, Duration::from_secs(61)).await;
        // 走过当天剩余的时间到下一个午夜之前。
        tick(&f, Duration::from_secs(23 * 3600 + 58 * 60)).await;
        assert!(f.events.events().len() >= usize::try_from(day - 9).unwrap());
    }
    // 每个午夜恰好一个 DayChanged，且没有别的事件。
    assert_eq!(
        f.events.events(),
        vec![
            DomainEvent::DayChanged { date: date(10, 10) },
            DomainEvent::DayChanged { date: date(10, 11) },
            DomainEvent::DayChanged { date: date(10, 12) },
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_clock_jump_over_several_days_publishes_a_single_event_with_the_latest_date() {
    let f = start(12, 0);
    // 先让监视器启动并记住"当前日期"，之后才改时间。
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    // 用户把系统时间向前改了 3 天：虚拟时间只走一小段，但墙上时钟跳了很远。
    f.clock.advance(chrono::Duration::days(3));
    tick(&f, Duration::from_secs(15 * 60)).await;

    assert_eq!(
        f.events.events(),
        vec![DomainEvent::DayChanged { date: date(10, 12) }]
    );
}

#[tokio::test(start_paused = true)]
async fn long_idle_stretches_are_checked_in_bounded_chunks_without_events() {
    let f = start(1, 0);
    // 白天空闲 10 小时：监视器会醒来多次核对，但日期没变就不发布。
    for _ in 0..40 {
        tick(&f, Duration::from_secs(15 * 60)).await;
    }
    assert!(f.events.events().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_clock_going_backwards_does_not_spin_or_publish() {
    let f = start(12, 0);
    f.clock.advance(chrono::Duration::hours(-5));
    tick(&f, Duration::from_secs(60)).await;
    assert!(f.events.events().is_empty());
}

#[tokio::test(start_paused = true)]
async fn stops_when_shutdown_completes() {
    let mut f = start(23, 59);
    let _ = f.stop.take().unwrap().send(());
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(f.task.is_finished());
    // 停止之后再过午夜也不会发布。
    f.clock.advance(chrono::Duration::hours(2));
    tokio::time::advance(Duration::from_secs(7200)).await;
    assert!(f.events.events().is_empty());
}
