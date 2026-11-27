//! Windows Credential Manager 适配器（`CredentialPort`，实施计划 9.1）。
//!
//! 凭据以 `CRED_TYPE_GENERIC` 保存，目标名是 `StarAt/<集成>/<账号>`，持久化范围是当前用户的本机
//! （`CRED_PERSIST_LOCAL_MACHINE`，不漫游）。内容按 UTF-8 字节写入 `CredentialBlob`，只有当前
//! Windows 用户能读取。

// 本模块含 Win32 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use starat_platform::credential::{CredentialKey, CredentialPort, Secret};
use starat_platform::error::PlatformError;
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
    CredReadW, CredWriteW,
};
use windows::core::{HRESULT, PCWSTR, PWSTR};

/// 凭据的最大字节数（Windows 对 `CredentialBlob` 的限制是 5 * 512 字节）。
const MAX_BLOB_BYTES: usize = 2560;

/// 基于 Windows Credential Manager 的凭据库。
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsCredentials;

impl WindowsCredentials {
    /// 创建适配器。
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

/// 以 `\0` 结尾的 UTF-16 目标名。
fn wide(target: &str) -> Vec<u16> {
    target.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 这个错误是不是「条目不存在」。
fn is_not_found(error: &windows::core::Error) -> bool {
    error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0)
}

/// 统一的失败包装：只带系统给的错误文本，不带凭据内容。
fn failed(action: &str, error: &windows::core::Error) -> PlatformError {
    PlatformError::Failed(format!("{action}凭据失败：{error}"))
}

impl WindowsCredentials {
    /// Read a credential by its current or legacy target name.
    fn read_target(&self, name: &str) -> Result<Option<Secret>, PlatformError> {
        let target = wide(name);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` 是以 0 结尾、在调用期间存活的 UTF-16 缓冲区；`credential` 是有效的输出指针，
        // 成功后由系统分配，下面用 `CredFree` 释放。
        let read = unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &raw mut credential,
            )
        };
        match read {
            Ok(()) => {}
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(failed("读取", &error)),
        }
        // SAFETY: 读取成功，`credential` 指向系统分配的有效 `CREDENTIALW`；`CredentialBlob` 指向
        // `CredentialBlobSize` 个字节，在 `CredFree` 之前一直有效。这里把内容复制出来再释放。
        let bytes = unsafe {
            let blob = (*credential).CredentialBlob;
            let size = (*credential).CredentialBlobSize as usize;
            let copied = if blob.is_null() || size == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(blob, size).to_vec()
            };
            CredFree(credential.cast_const().cast());
            copied
        };
        String::from_utf8(bytes)
            .map(|text| Some(Secret::new(text)))
            .map_err(|_| PlatformError::Failed("读取凭据失败：内容不是有效的文本".to_owned()))
    }
}

impl CredentialPort for WindowsCredentials {
    /// Read the renamed credential first, then credentials saved by the previous app.
    fn get(&self, key: &CredentialKey) -> Result<Option<Secret>, PlatformError> {
        let name = key.target_name();
        if let Some(secret) = self.read_target(&name)? {
            return Ok(Some(secret));
        }
        for prefix in ["StarDeskBox/", "Nivlo/"] {
            if let Some(secret) = self.read_target(&name.replacen("StarAt/", prefix, 1))? {
                return Ok(Some(secret));
            }
        }
        Ok(None)
    }

    /// 保存（覆盖）。
    fn set(&self, key: &CredentialKey, secret: &Secret) -> Result<(), PlatformError> {
        let mut target = wide(&key.target_name());
        let mut blob = secret.expose().as_bytes().to_vec();
        if blob.len() > MAX_BLOB_BYTES {
            return Err(PlatformError::Failed("凭据太长，无法保存".to_owned()));
        }
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: u32::try_from(blob.len()).unwrap_or(0),
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: `credential` 引用的目标名与内容缓冲区（`target`、`blob`）在调用期间都存活且可读；
        // `CredWriteW` 只读取它们并复制到凭据库。
        unsafe { CredWriteW(&raw const credential, 0) }.map_err(|error| failed("保存", &error))?;
        // 尽早清掉内存里的明文副本。
        blob.iter_mut().for_each(|byte| *byte = 0);
        Ok(())
    }

    /// 删除：不存在也算成功。
    fn delete(&self, key: &CredentialKey) -> Result<(), PlatformError> {
        let name = key.target_name();
        for prefix in ["StarAt/", "StarDeskBox/", "Nivlo/"] {
            let target = wide(&name.replacen("StarAt/", prefix, 1));
            // SAFETY: `target` 是以 0 结尾、在调用期间存活的 UTF-16 缓冲区。
            match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
                Ok(()) => {}
                Err(error) if is_not_found(&error) => {}
                Err(error) => return Err(failed("删除", &error)),
            }
        }
        Ok(())
    }
}
