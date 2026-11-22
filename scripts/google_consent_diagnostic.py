#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Collect Google consent-page diagnostics from the persistent headless Chromium tab."""

import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path


DIAGNOSTIC_JS = r"""
const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const visible = (element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' &&
    style.opacity !== '0';
};
const buttons = Array.from(document.querySelectorAll(
  'button, [role="button"], input[type="submit"], input[type="button"]'
)).filter(visible).map((element, index) => ({
  index: index + 1,
  tag: element.tagName.toLowerCase(),
  text: clean(element.innerText || element.textContent || element.value, 300),
  ariaLabel: element.getAttribute('aria-label'),
  title: element.getAttribute('title'),
  id: element.id || null,
  name: element.getAttribute('name'),
  type: element.getAttribute('type'),
  value: element.value || null,
  disabled: !!element.disabled,
  formAction: element.form ? element.form.action : null
}));
const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map((element) => ({
  tag: element.tagName.toLowerCase(),
  type: element.type || null,
  name: element.name || null,
  id: element.id || null,
  ariaLabel: element.getAttribute('aria-label'),
  value: element.type === 'hidden' ? '[hidden]' : clean(element.value, 120)
}));
const forms = Array.from(document.forms).map((form) => ({
  action: form.action || null,
  method: form.method || null,
  id: form.id || null,
  name: form.name || null,
  buttonCount: form.querySelectorAll('button, input[type="submit"]').length
}));
const frames = Array.from(document.querySelectorAll('iframe')).map((frame) => ({
  src: frame.src || null,
  title: frame.title || null,
  name: frame.name || null
}));
return JSON.stringify({
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  language: document.documentElement.lang || null,
  bodyText: clean(document.body ? document.body.innerText : '', 10000),
  buttons,
  inputs,
  forms,
  frames,
  consentSignals: {
    knownButtonId: !!document.querySelector('#L2AGLb'),
    consentHost: location.hostname.includes('consent.google.')
  }
});
"""


def main():
    from DrissionPage import Chromium, ChromiumOptions

    port = int(os.environ.get("DP_BROWSER_PORT", "9333"))
    options = ChromiumOptions().set_local_port(port)
    browser = Chromium(options)
    tabs = browser.get_tabs()
    if not tabs:
        raise RuntimeError("The persistent Chromium instance has no open tabs.")

    tab = browser.latest_tab
    raw = tab.run_js(DIAGNOSTIC_JS)
    data = json.loads(raw) if isinstance(raw, str) else raw

    screenshot_path = None
    user_data = os.environ.get("DP_USER_DATA", "").strip()
    base_dir = Path(user_data).parent if user_data else Path(tempfile.gettempdir())
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
        screenshot = base_dir / "google-consent-diagnostic.png"
        tab.get_screenshot(path=str(screenshot), full_page=True)
        screenshot_path = str(screenshot)
    except Exception as error:
        data["screenshotError"] = str(error)

    data["tabId"] = tab.tab_id
    data["tabCount"] = len(tabs)
    data["screenshotPath"] = screenshot_path
    print(json.dumps({"ok": True, "diagnostic": data}, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc()[-3000:]
        }, ensure_ascii=False))
        sys.exit(1)
