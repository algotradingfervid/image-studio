//! macOS system hooks that lock the vault: Mac going to sleep
//! (`NSWorkspaceWillSleepNotification`), the login session deactivating (fast
//! user switching) and the screen locking (the distributed notification
//! `com.apple.screenIsLocked`, which is what the lock screen posts).
//!
//! Observers are registered once for the life of the process (the returned
//! observer tokens are intentionally leaked). The callback runs on the main
//! thread. The inactivity timer remains the backstop on every platform.

#[cfg(target_os = "macos")]
pub fn install(on_event: impl Fn() + Send + Sync + 'static) -> bool {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceSessionDidResignActiveNotification,
        NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};
    use std::ptr::NonNull;

    let cb = std::sync::Arc::new(on_event);
    let block = RcBlock::new(move |_n: NonNull<NSNotification>| cb());
    // SAFETY: plain Cocoa notification-center calls on the main thread; the
    // block is copied by the center and the observer tokens are kept alive
    // for the whole process (forgotten), as Apple's API requires.
    unsafe {
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        let screen_locked = NSString::from_str("com.apple.screenIsLocked");
        std::mem::forget(distributed.addObserverForName_object_queue_usingBlock(
            Some(&screen_locked),
            None,
            None,
            &block,
        ));
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        for name in [
            NSWorkspaceWillSleepNotification,
            NSWorkspaceSessionDidResignActiveNotification,
        ] {
            std::mem::forget(workspace.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                None,
                &block,
            ));
        }
    }
    true
}

/// Other platforms: no system hook; the inactivity timer alone locks the vault.
#[cfg(not(target_os = "macos"))]
pub fn install(_on_event: impl Fn() + Send + Sync + 'static) -> bool {
    false
}
