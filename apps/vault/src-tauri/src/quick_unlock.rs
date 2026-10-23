// iPhone: unlock with Face ID. The account email and password sit in the Keychain on this device only,
// behind Face ID (or the iPhone's passcode when Face ID fails); reading them back is what brings up the
// Face ID prompt. The same job as BiometricUnlock.kt on Android.
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFTypeRef, OSStatus};
use core_foundation_sys::data::CFDataRef;
use core_foundation_sys::string::CFStringRef;
use security_framework_sys::access_control::{kSecAccessControlUserPresence, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, SecAccessControlCreateWithFlags};
use security_framework_sys::item::{kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnData, kSecValueData};
use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};

#[link(name = "Security", kind = "framework")]
extern "C" {
    // The line under "Vault" on the Face ID / passcode sheet.
    static kSecUseOperationPrompt: CFStringRef;
}

const SERVICE: &str = "dev.marobotic.vault.quick-unlock";
const ACCOUNT: &str = "account";
const USER_CANCELED: OSStatus = -128;
const ITEM_NOT_FOUND: OSStatus = -25300;

fn key(k: CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(k) }
}

fn item() -> Vec<(CFString, CFType)> {
    unsafe {
        vec![
            (key(kSecClass), key(kSecClassGenericPassword).as_CFType()),
            (key(kSecAttrService), CFString::new(SERVICE).as_CFType()),
            (key(kSecAttrAccount), CFString::new(ACCOUNT).as_CFType()),
        ]
    }
}

pub fn clear() {
    unsafe { SecItemDelete(CFDictionary::from_CFType_pairs(&item()).as_concrete_TypeRef()) };
}

/// Saving needs no Face ID; it fails when the iPhone has no passcode (nothing to seal it with).
pub fn save(secret: &[u8]) -> Result<(), String> {
    clear();
    let access = unsafe {
        SecAccessControlCreateWithFlags(std::ptr::null(), kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as CFTypeRef, kSecAccessControlUserPresence, std::ptr::null_mut())
    };
    if access.is_null() {
        return Err("the Keychain couldn't be locked with Face ID".into());
    }
    let mut add = item();
    unsafe {
        add.push((key(kSecAttrAccessControl), CFType::wrap_under_create_rule(access as CFTypeRef)));
        add.push((key(kSecValueData), CFData::from_buffer(secret).as_CFType()));
    }
    match unsafe { SecItemAdd(CFDictionary::from_CFType_pairs(&add).as_concrete_TypeRef(), std::ptr::null_mut()) } {
        0 => Ok(()),
        s => Err(format!("the Keychain refused it (error {s}); is a passcode set on this iPhone?")),
    }
}

/// Blocks while the Face ID sheet is up, so never call it on the main thread.
/// Errors: "cancelled", "gone" (nothing saved any more), or a message to show.
pub fn open(prompt: &str) -> Result<Vec<u8>, String> {
    let mut query = item();
    unsafe {
        query.push((key(kSecReturnData), CFBoolean::true_value().as_CFType()));
        query.push((key(kSecUseOperationPrompt), CFString::new(prompt).as_CFType()));
    }
    let mut out: CFTypeRef = std::ptr::null();
    match unsafe { SecItemCopyMatching(CFDictionary::from_CFType_pairs(&query).as_concrete_TypeRef(), &mut out) } {
        0 if !out.is_null() => Ok(unsafe { CFData::wrap_under_create_rule(out as CFDataRef) }.bytes().to_vec()),
        USER_CANCELED => Err("cancelled".into()),
        ITEM_NOT_FOUND => Err("gone".into()),
        s => Err(format!("Face ID didn't open it (error {s})")),
    }
}
