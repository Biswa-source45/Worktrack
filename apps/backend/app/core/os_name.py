"""Display names for operating systems, as reported by phones and browsers."""

import re

# Phones on the first app version reported `Platform.OS Platform.Version`: "ios 27.0.1", and on
# Android the API level ("android 33"), not the version people know.
_ANDROID_API = {
    21: "5.0", 22: "5.1", 23: "6", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10",
    30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
}  # fmt: skip
_NAMES = {"ios": "iOS", "ipados": "iPadOS", "android": "Android"}
_OLD_ANDROID = re.compile(r"android (\d+)")


def format_os(os: str) -> str:
    """ "ios 27.0.1" -> "iOS 27.0.1", "android 33" -> "Android 13"; anything else is unchanged."""
    old = _OLD_ANDROID.fullmatch(os)
    if old:
        level = int(old.group(1))
        return f"Android {_ANDROID_API.get(level, f'(API {level})')}"
    name, _, version = os.partition(" ")
    proper = _NAMES.get(name.lower())
    return os if proper is None else f"{proper} {version}".strip()
