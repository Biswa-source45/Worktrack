"""Browser and operating system from a User-Agent header, for the sessions list.

Display only, never a security decision: a client can send any string it likes.
"""

import re

# Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari".
_BROWSERS = (
    ("Edge", re.compile(r"Edg(?:e|A|iOS)?/(\d+)")),
    ("Opera", re.compile(r"OPR/(\d+)")),
    ("Firefox", re.compile(r"(?:Firefox|FxiOS)/(\d+)")),
    ("Chrome", re.compile(r"(?:Chrome|CriOS)/(\d+)")),
    ("Safari", re.compile(r"Version/(\d+)[\d.]* (?:Mobile/\w+ )?Safari/")),
)
_SYSTEMS = (
    ("Android", re.compile(r"Android (\d+(?:\.\d+)*)")),
    ("iOS", re.compile(r"(?:iPhone|CPU) OS (\d+(?:_\d+)*)")),
    ("Windows", re.compile(r"Windows NT")),
    ("macOS", re.compile(r"Mac OS X")),
    ("ChromeOS", re.compile(r"CrOS")),
    ("Linux", re.compile(r"Linux")),
)


def parse_user_agent(user_agent: str | None) -> tuple[str | None, str | None]:
    """Return (browser, os), e.g. ("Chrome 141", "Windows"); None for what is not recognised."""
    if not user_agent:
        return None, None
    browser = system = None
    for name, pattern in _BROWSERS:
        match = pattern.search(user_agent)
        if match:
            browser = f"{name} {match.group(1)}"
            break
    for name, pattern in _SYSTEMS:
        match = pattern.search(user_agent)
        if match:
            version = match.group(1).replace("_", ".") if match.groups() else ""
            system = f"{name} {version}".strip()
            break
    return browser, system
