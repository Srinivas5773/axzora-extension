// background.js - Service Worker
import { CONFIG } from "./config.js";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Axzora Job Applier Extension installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Axzora Job Applier Extension started");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openJobInNewTab') {
    chrome.tabs.create({ url: request.url }, (tab) => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

});