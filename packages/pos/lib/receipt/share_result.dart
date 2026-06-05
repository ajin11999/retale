/// Outcome of an attempt to share the receipt file via the platform share
/// sheet (Web Share API on web, the OS share on desktop).
enum ShareResult {
  /// The share sheet was invoked. Where the file ends up (WhatsApp, email, …)
  /// is the OS's business from here.
  shared,

  /// The user dismissed the share sheet without sending — a no-op, not an error.
  dismissed,

  /// This platform/browser can't share files (no Web Share API, or an insecure
  /// context such as plain HTTP over the LAN). The caller should fall back to
  /// printing or the text deep link.
  unsupported,

  /// Something went wrong while preparing or invoking the share.
  failed,
}
