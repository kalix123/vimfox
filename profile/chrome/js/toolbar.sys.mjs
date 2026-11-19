// Toolbar layout and the add-ons tray (the puzzle-piece button).
//
// The layout is applied once per layout version, not on every start, so the
// user's own changes (pinning an add-on, removing a button) stick. Newly
// installed add-ons go into the puzzle tray instead of onto the toolbar;
// right-click → Pin to Toolbar still puts one there.

const LAYOUT_PREF = "vimfox.toolbarLayout";
const LAYOUT_VERSION = 1;

// Order in the nav-bar. The downloads and settings buttons are pinned to the
// sidebar footer and the address bar to its own row by userChrome.css.
const NAV_BAR = [
  "downloads-button",
  "preferences-button",
  "unified-extensions-button",
  "vertical-spacer",
  "back-button",
  "forward-button",
  "sidebar-button",
  "urlbar-container",
];
const REMOVE = ["stop-reload-button", "alltabs-button", "smartwindow-group-tabs-button", "ai-window-toggle", "reset-pbm-toolbar-button"];

const isAddonButton = (id) => id.endsWith("-browser-action");

// Same transformation Firefox uses to name an extension's toolbar button.
const addonButtonId = (addonId) => `${addonId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-browser-action`;

export function applyLayoutOnce(CustomizableUI) {
  if (Services.prefs.getIntPref(LAYOUT_PREF, 0) >= LAYOUT_VERSION) return;
  NAV_BAR.forEach((id, i) => CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR, i));
  for (const id of REMOVE) {
    if (CustomizableUI.getPlacementOfWidget(id)?.area === CustomizableUI.AREA_NAVBAR) {
      CustomizableUI.removeWidgetFromArea(id);
    }
  }
  for (const id of CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR)) {
    if (isAddonButton(id)) CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_ADDONS);
  }
  Services.prefs.setIntPref(LAYOUT_PREF, LAYOUT_VERSION);
}

// An add-on's button can be created just before or just after the install
// notification, so watch both for a short while after each install.
export function newAddonsGoToTray(CustomizableUI, AddonManager, setTimeout) {
  const justInstalled = new Set();
  const toTray = (id) => {
    if (CustomizableUI.getPlacementOfWidget(id)?.area === CustomizableUI.AREA_NAVBAR) {
      CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_ADDONS);
      justInstalled.delete(id);
    }
  };
  AddonManager.addAddonListener({
    onInstalled(addon) {
      if (addon.type !== "extension") return;
      const id = addonButtonId(addon.id);
      justInstalled.add(id);
      setTimeout(() => toTray(id), 0);
      setTimeout(() => justInstalled.delete(id), 15000);
    },
  });
  CustomizableUI.addListener({
    onWidgetAdded(id, area) {
      if (area === CustomizableUI.AREA_NAVBAR && justInstalled.has(id)) setTimeout(() => toTray(id), 0);
    },
  });
}
