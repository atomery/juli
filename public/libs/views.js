/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/* eslint-disable no-param-reassign */
const {
  BrowserView,
  BrowserWindow,
  MenuItem,
  app,
  ipcMain,
  session,
  shell,
} = require('electron');
const path = require('path');
const fsExtra = require('fs-extra');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const unusedFilename = require('unused-filename');
const pupa = require('pupa');
const extName = require('ext-name');

const appJson = require('../app.json');

const { getPreference, getPreferences } = require('./preferences');
const {
  getWorkspace,
  getWorkspaces,
  getWorkspacePreference,
  getWorkspacePreferences,
  setWorkspace,
  removeWorkspaceAccountInfo,
} = require('./workspaces');
const {
  setWorkspaceMeta,
  getWorkspaceMeta,
  getWorkspaceMetas,
  setWorkspaceBadgeCount,
} = require('./workspace-metas');
const ContextMenuBuilder = require('./context-menu-builder');

const sendToAllWindows = require('./send-to-all-windows');
const getViewBounds = require('./get-view-bounds');
const customizedFetch = require('./customized-fetch');

const views = {};
let shouldMuteAudio;
let shouldPauseNotifications;
let firstLoadPreferences;

/* electron-dl port start */
// MIT License: https://github.com/sindresorhus/electron-dl/blob/master/license
// https://github.com/sindresorhus/electron-dl
const downloadItems = new Set();
let receivedBytes = 0;
let completedBytes = 0;
let totalBytes = 0;
const activeDownloadItems = () => downloadItems.size;
const progressDownloadItems = () => receivedBytes / totalBytes;

const getFilenameFromMime = (name, mime) => {
  const extensions = extName.mime(mime);

  if (extensions.length !== 1) {
    return name;
  }

  return `${name}.${extensions[0].ext}`;
};
/* electron-dl port end */

const extractDomain = (fullUrl) => {
  if (!fullUrl) return null;
  const matches = fullUrl.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);
  const domain = matches && matches[1];
  // https://stackoverflow.com/a/9928725
  return domain ? domain.replace(/^(www\.)/, '') : null;
};

// https://stackoverflow.com/a/14645182
const isSubdomain = (url) => {
  const regex = new RegExp(/^([a-z]+:\/{2})?([\w-]+\.[\w-]+\.\w+)$/);
  return !!url.match(regex); // make sure it returns boolean
};

const badgeRules = [
  // "(2) Inbox | Gmail"
  /(?<=[([{])(\d*?)(?=[}\])])/,
  // "1 · Inbox — Yandex.Mail"
  // eslint-disable-next-line no-irregular-whitespace
  // "1 • Inbox | Fastmail"
  // eslint-disable-next-line no-irregular-whitespace
  /(?<=^)(\d*?)(?=[  ][•·-])/,
];
const getBadgeCountFromTitle = (title) => {
  for (let i = 0; i < badgeRules.length; i += 1) {
    const matches = badgeRules[i].exec(title);
    const incStr = matches ? matches[1] : '';
    const inc = parseInt(incStr, 10);
    if (inc) return inc;
  }
  return 0;
};

const equivalentDomain = (domain) => {
  if (!domain) return null;

  let eDomain = domain;

  const prefixes = [
    'www', 'app', 'login', 'go', 'accounts', 'open', 'web', 'join',
    'auth', 'hello',
  ];
  // app.portcast.io ~ portcast.io
  // login.xero.com ~ xero.com
  // go.xero.com ~ xero.com
  // accounts.google.com ~ google.com
  // open.spotify.com ~ spotify.com
  // web.whatsapp.com ~ whatsapp.com
  // join.slack.com ~ slack.com
  // auth.monday.com ~ monday.com
  // hello.dubsado.com ~ dubsado.com

  // remove one by one not to break domain
  prefixes.forEach((prefix) => {
    // check if subdomain, if not return the domain
    if (isSubdomain(eDomain)) {
      // https://stackoverflow.com/a/9928725
      const regex = new RegExp(`^(${prefix}.)`);
      eDomain = eDomain.replace(regex, '');
    }
  });

  return eDomain;
};

const isMicrosoftUrl = (url) => /.+(microsoft.com|live.com|1drv.ms|office.com|sharepoint.com|skype.com)/g.test(url);

const isInternalUrl = (url, currentInternalUrls) => {
  // // Google Printing PDF CDN
  if (url && url.includes('apps-viewer.googleusercontent.com')) {
    return true;
  }

  // google have a lot of redirections after logging in
  // so assume any requests made after 'accounts.google.com' are internals
  for (let i = 0; i < currentInternalUrls.length; i += 1) {
    if (currentInternalUrls[i] && currentInternalUrls[i].startsWith('https://accounts.google.com')) {
      return true;
    }
  }

  // external links sent in Google Meet meeting goes through this link first
  // https://meet.google.com/linkredirect?authuser=1&dest=https://something.com
  if (url.startsWith('https://meet.google.com/linkredirect')) {
    return false;
  }

  // Microsoft uses many different domains
  // So we define special rules for it
  if (isMicrosoftUrl(url)) {
    for (let i = 0; i < currentInternalUrls.length; i += 1) {
      if (currentInternalUrls[i] && isMicrosoftUrl(currentInternalUrls[i])) {
        return true;
      }
    }
  }

  const domain = equivalentDomain(extractDomain(url));
  const matchedInternalUrl = currentInternalUrls.find((internalUrl) => {
    const internalDomain = equivalentDomain(extractDomain(internalUrl));

    // Ex: music.yandex.ru => passport.yandex.ru?retpath=....music.yandex.ru
    // https://github.com/webcatalog/webcatalog-app/issues/546#issuecomment-586639519
    if (domain === 'clck.yandex.ru' || domain === 'passport.yandex.ru') {
      return url.includes(internalDomain);
    }

    // domains match
    return domain === internalDomain;
  });

  return Boolean(matchedInternalUrl);
};

const addView = (browserWindow, workspace) => {
  if (views[workspace.id] != null) return;

  // ensure that to change the preferences
  // user needs to restart the app
  // this is to ensure consistency between views
  firstLoadPreferences = firstLoadPreferences || getPreferences();
  const {
    blockAds,
    proxyBypassRules,
    proxyPacScript,
    proxyRules,
    proxyType,
    rememberLastPageVisited,
    shareWorkspaceBrowsingData,
    spellcheck,
    spellcheckLanguages,
    unreadCountBadge,
  } = firstLoadPreferences;

  // configure session, proxy & ad blocker
  const ses = session.fromPartition(shareWorkspaceBrowsingData ? 'persist:shared' : `persist:${workspace.id}`);

  // proxy
  if (proxyType === 'rules') {
    ses.setProxy({
      proxyRules,
      proxyBypassRules,
    });
  } else if (proxyType === 'pacScript') {
    ses.setProxy({
      proxyPacScript,
      proxyBypassRules,
    });
  }
  // blocker
  if (blockAds) {
    ElectronBlocker.fromPrebuiltAdsAndTracking(customizedFetch, {
      path: path.join(app.getPath('userData'), 'adblocker.bin'),
      read: fsExtra.readFile,
      write: fsExtra.writeFile,
    }).then((blocker) => {
      blocker.enableBlockingInSession(ses);
    });
  }
  // spellchecker
  if (spellcheck && process.platform !== 'darwin') {
    ses.setSpellCheckerLanguages(spellcheckLanguages);
  }

  const sharedWebPreferences = {
    spellcheck,
    nativeWindowOpen: true,
    nodeIntegration: false,
    contextIsolation: true,
    plugins: true, // PDF reader
    enableRemoteModule: false,
    scrollBounce: true,
    session: ses,
    preload: path.join(__dirname, '..', 'preload', 'view.js'),
  };
  const view = new BrowserView({
    webPreferences: sharedWebPreferences,
  });
  view.webContents.workspaceId = workspace.id;
  // background needs to explictly set
  // if not, by default, the background of BrowserView is transparent
  // which would break the CSS of certain websites
  // even with dark mode, all major browsers
  // always use #FFF as default page background
  // https://github.com/webcatalog/webcatalog-app/issues/723
  // https://github.com/electron/electron/issues/16212
  view.setBackgroundColor('#FFF');

  // fix Google prevents signing in because of security concerns
  // https://github.com/webcatalog/webcatalog-app/issues/455
  // https://github.com/meetfranz/franz/issues/1720#issuecomment-566460763
  const fakedEdgeUaStr = `${app.userAgentFallback} Edge/18.18875`;
  const adjustUserAgentByUrl = (contents, url, occasion) => {
    const currentUaStr = contents.userAgent;

    const customUserAgent = getWorkspacePreference(workspace.id, 'customUserAgent') || getPreference('customUserAgent');
    if (customUserAgent) {
      if (currentUaStr !== customUserAgent) {
        contents.userAgent = customUserAgent;
        return true;
      }
      return false;
    }

    const navigatedDomain = extractDomain(url);
    if (navigatedDomain === 'accounts.google.com') {
      if (currentUaStr !== fakedEdgeUaStr) {
        contents.userAgent = fakedEdgeUaStr;
        // eslint-disable-next-line no-console
        console.log('Changed user agent to', fakedEdgeUaStr, 'for web compatibility URL: ', url, 'when', occasion);
        return true;
      }
    } else if (currentUaStr !== app.userAgentFallback) {
      contents.userAgent = app.userAgentFallback;
      // eslint-disable-next-line no-console
      console.log('Changed user agent to', app.userAgentFallback, 'for web compatibility URL: ', url, 'when', occasion);
      return true;
    }
    return false;
  };

  view.webContents.on('will-navigate', (e, nextUrl) => {
    // open external links in browser
    // https://github.com/webcatalog/webcatalog-app/issues/849#issuecomment-629587264
    // this behavior is likely to break many apps (eg Microsoft Teams)
    // apply this rule only to github.com for now
    const appUrl = getWorkspace(workspace.id).homeUrl || appJson.url;
    const currentUrl = e.sender.getURL();
    const appDomain = extractDomain(appUrl);
    const currentDomain = extractDomain(currentUrl);
    if (
      ((appDomain && appDomain.includes('github.com')) || (currentDomain && currentDomain.includes('github.com')))
      && !isInternalUrl(nextUrl, [appUrl, currentUrl])
    ) {
      e.preventDefault();
      shell.openExternal(nextUrl);
    }

    // strip account info when logging out
    if (nextUrl.startsWith('https://accounts.google.com/Logout')) {
      removeWorkspaceAccountInfo(workspace.id);
    }
  });

  view.webContents.on('did-start-loading', () => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    if (workspaceObj.active) {
      if (getWorkspaceMeta(workspace.id).didFailLoad) {
        // show browserView again when reloading after error
        // see did-fail-load event
        if (browserWindow && !browserWindow.isDestroyed()) { // fix https://github.com/atomery/singlebox/issues/228
          const contentSize = browserWindow.getContentSize();
          view.setBounds(getViewBounds(contentSize));
        }
      }
    }

    setWorkspaceMeta(workspace.id, {
      didFailLoad: null,
      isLoading: true,
    });
  });

  view.webContents.on('did-stop-loading', () => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    if (workspaceObj.active) {
      sendToAllWindows('update-address', view.webContents.getURL(), false);
    }

    const currentUrl = view.webContents.getURL();
    setWorkspace(workspace.id, {
      lastUrl: currentUrl,
    });
    ipcMain.emit('request-realign-active-workspace');
  });

  // focus on initial load
  // https://github.com/webcatalog/webcatalog-app/issues/398
  if (workspace.active) {
    view.webContents.once('did-stop-loading', () => {
      if (browserWindow && !browserWindow.isDestroyed()
        && browserWindow.isFocused() && !view.webContents.isFocused()) {
        view.webContents.focus();
      }
    });
  }

  // https://electronjs.org/docs/api/web-contents#event-did-fail-load
  view.webContents.on('did-fail-load', (e, errorCode, errorDesc, validateUrl, isMainFrame) => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    if (isMainFrame && errorCode < 0 && errorCode !== -3) {
      setWorkspaceMeta(workspace.id, {
        didFailLoad: errorDesc,
        isLoading: false,
      });
      if (workspaceObj.active) {
        sendToAllWindows('update-loading', false);
        if (browserWindow && !browserWindow.isDestroyed()) { // fix https://github.com/atomery/singlebox/issues/228
          const contentSize = browserWindow.getContentSize();
          view.setBounds(
            getViewBounds(contentSize, false, 0, 0),
          ); // hide browserView to show error message
        }
        sendToAllWindows('update-did-fail-load', true);
      }
    }

    // edge case to handle failed auth
    if (errorCode === -300 && view.webContents.getURL().length === 0) {
      view.webContents.loadURL(workspaceObj.homeUrl || appJson.url);
    }
  });

  view.webContents.on('did-navigate', (e, url) => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    // fix "Google Chat isn't supported on your current browser"
    // https://github.com/webcatalog/webcatalog-app/issues/820
    if (url && url.indexOf('error/browser-not-supported') > -1 && url.startsWith('https://chat.google.com')) {
      const ref = new URL(url).searchParams.get('ref') || '';
      view.webContents.loadURL(`https://chat.google.com${ref}`);
    }

    // fix Google prevents signing in because of security concerns
    // https://github.com/webcatalog/webcatalog-app/issues/455
    // https://github.com/meetfranz/franz/issues/1720#issuecomment-566460763
    // will-navigate doesn't trigger for loadURL, goBack, goForward
    // so user agent to needed to be double check here
    // not the best solution as page will be unexpectedly reloaded
    // but it won't happen very often
    if (adjustUserAgentByUrl(view.webContents, url, 'did-navigate')) {
      view.webContents.reload();
    }

    if (workspaceObj.active) {
      sendToAllWindows('update-can-go-back', view.webContents.canGoBack());
      sendToAllWindows('update-can-go-forward', view.webContents.canGoForward());
      sendToAllWindows('update-address', url, false);
    }
  });

  view.webContents.on('did-navigate-in-page', (e, url) => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    if (workspaceObj.active) {
      sendToAllWindows('update-can-go-back', view.webContents.canGoBack());
      sendToAllWindows('update-can-go-forward', view.webContents.canGoForward());
      sendToAllWindows('update-address', url, false);
    }
  });

  view.webContents.on('page-title-updated', (e, title) => {
    const workspaceObj = getWorkspace(workspace.id);
    // this event might be triggered
    // even after the workspace obj and BrowserView
    // are destroyed. See https://github.com/webcatalog/webcatalog-app/issues/836
    if (!workspaceObj) return;

    if (workspaceObj.active) {
      sendToAllWindows('update-title', title);
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.setTitle(title);
      }
    }
  });

  const handleNewWindow = (e, nextUrl, frameName, disposition, options) => {
    const appUrl = getWorkspace(workspace.id).homeUrl || appJson.url;
    const appDomain = extractDomain(appUrl);
    const currentUrl = e.sender.getURL();
    const currentDomain = extractDomain(currentUrl);
    const nextDomain = extractDomain(nextUrl);

    const openInNewWindow = () => {
      // https://gist.github.com/Gvozd/2cec0c8c510a707854e439fb15c561b0
      e.preventDefault();

      // if 'new-window' is triggered with Cmd+Click
      // options is undefined
      // https://github.com/webcatalog/webcatalog-app/issues/842
      const cmdClick = Boolean(!options);
      const newOptions = cmdClick ? {
        show: true,
        width: 800,
        height: 600,
        webPreferences: sharedWebPreferences,
      } : options;
      const popupWin = new BrowserWindow(newOptions);
      // WebCatalog internal value to determine whether BrowserWindow is popup
      popupWin.isPopup = true;
      popupWin.setMenuBarVisibility(false);
      popupWin.webContents.on('new-window', handleNewWindow);

      // fix Google prevents signing in because of security concerns
      // https://github.com/webcatalog/webcatalog-app/issues/455
      // https://github.com/meetfranz/franz/issues/1720#issuecomment-566460763
      // will-navigate doesn't trigger for loadURL, goBack, goForward
      // so user agent to needed to be double check here
      // not the best solution as page will be unexpectedly reloaded
      // but it won't happen very often
      popupWin.webContents.on('did-navigate', (ee, url) => {
        if (adjustUserAgentByUrl(ee.sender, url, 'popup-did-navigate')) {
          ee.sender.reload();
        }
      });

      // if 'new-window' is triggered with Cmd+Click
      // url is not loaded automatically
      // https://github.com/webcatalog/webcatalog-app/issues/842
      if (cmdClick) {
        popupWin.loadURL(nextUrl);
      }

      e.newGuest = popupWin;
    };

    // Conditions are listed by order of priority

    // check defined internal URL rule
    // https://webcatalog.app/internal-urls
    const internalUrlRule = getWorkspacePreference(workspace.id, 'internalUrlRule') || getPreference('internalUrlRule');
    if (nextUrl && internalUrlRule) {
      const re = new RegExp(`^${internalUrlRule}$`, 'i');
      if (re.test(nextUrl)) {
        openInNewWindow();
        return;
      }
    }

    // regular new-window event
    // or if in Google Drive app, open Google Docs files internally https://github.com/webcatalog/webcatalog-app/issues/800
    // the next external link request will be opened in new window
    if (
      disposition === 'new-window'
      || disposition === 'default'
      || (appDomain === 'drive.google.com' && nextDomain === 'docs.google.com')
    ) {
      openInNewWindow();
      return;
    }

    // load in same window
    if (
      (appDomain.endsWith('slack.com') && nextDomain.endsWith('slack.com'))
      // Google: Add account
      || nextDomain === 'accounts.google.com'
      // Google: Switch account
      || (
        nextDomain && nextDomain.indexOf('google.com') > 0
        && isInternalUrl(nextUrl, [appUrl, currentUrl])
        && (
          (nextUrl.indexOf('authuser=') > -1) // https://drive.google.com/drive/u/1/priority?authuser=2 (has authuser query)
          || (/\/u\/[0-9]+\/{0,1}$/.test(nextUrl)) // https://mail.google.com/mail/u/1/ (ends with /u/1/)
        )
      )
      // https://github.com/webcatalog/webcatalog-app/issues/315
      || ((appDomain.includes('asana.com') || currentDomain.includes('asana.com')) && nextDomain.includes('asana.com'))
      // handle OneDrive login URL
      // https://github.com/webcatalog/webcatalog-app/issues/1250
      || nextUrl.startsWith('https://go.microsoft.com/fwlink/p/?LinkID=2119709')
      || nextUrl.startsWith('https://go.microsoft.com/fwlink/p/?LinkID=2116067')
    ) {
      e.preventDefault();
      e.sender.loadURL(nextUrl);
      return;
    }

    // open new window if the link is internal
    if (isInternalUrl(nextUrl, [appUrl, currentUrl])) {
      openInNewWindow();
      return;
    }

    // special case for Roam Research
    // if popup window is not opened and loaded, Roam crashes (shows white page)
    // https://github.com/webcatalog/webcatalog-app/issues/793
    if (
      appDomain === 'roamresearch.com'
      && nextDomain != null
      && (disposition === 'foreground-tab' || disposition === 'background-tab')
    ) {
      e.preventDefault();
      shell.openExternal(nextUrl);

      // mock window
      // close as soon as it did-navigate
      const newOptions = {
        ...options,
        show: false,
      };
      const popupWin = new BrowserWindow(newOptions);
      popupWin.once('did-navigate', () => {
        popupWin.close();
      });
      e.newGuest = popupWin;
      return;
    }

    // open external url in browser
    if (
      nextDomain != null
      && (disposition === 'foreground-tab' || disposition === 'background-tab')
    ) {
      e.preventDefault();
      shell.openExternal(nextUrl);
      return;
    }

    // App tries to open external link using JS
    // nextURL === 'about:blank' but then window will redirect to the external URL
    // https://github.com/webcatalog/webcatalog-app/issues/467#issuecomment-569857721
    if (
      nextDomain === null
      && (disposition === 'foreground-tab' || disposition === 'background-tab')
    ) {
      e.preventDefault();
      const newOptions = {
        ...options,
        show: false,
      };
      const popupWin = new BrowserWindow(newOptions);
      // WebCatalog internal value to determine whether BrowserWindow is popup
      popupWin.isPopup = true;
      popupWin.setMenuBarVisibility(false);
      popupWin.webContents.on('new-window', handleNewWindow);
      popupWin.webContents.once('will-navigate', (_, url) => {
        // if the window is used for the current app, then use default behavior
        if (isInternalUrl(url, [appUrl, currentUrl])) {
          popupWin.show();
        } else { // if not, open in browser
          e.preventDefault();
          shell.openExternal(url);
          popupWin.close();
        }
      });
      e.newGuest = popupWin;
    }
  };
  view.webContents.on('new-window', handleNewWindow);

  // Handle downloads
  // https://electronjs.org/docs/api/download-item
  const willDownloadListener = (event, item) => {
    const globalPreferences = getPreferences();
    const workspacePreferences = getWorkspacePreferences(workspace.id);
    const downloadPath = workspacePreferences.downloadPath || globalPreferences.downloadPath;
    const askForDownloadPath = (workspacePreferences.askForDownloadPath != null
      ? workspacePreferences.askForDownloadPath
      : globalPreferences.askForDownloadPath) || global.forceSaveAs;
    // use for "save image as..." feature
    global.forceSaveAs = false;

    const options = {
      directory: downloadPath,
      saveAs: askForDownloadPath,
      // on macOS, if the file is downloaded to default Download dir
      // we bounce the dock icon
      // for other directories, as they're not on dock, we open the dir in Finder
      // for other platforms, always open the dir in file explorer
      openFolderWhenDone: globalPreferences.openFolderWhenDoneDownloading,
    };
    const callback = () => {};

    /* electron-dl port start */
    // https://github.com/sindresorhus/electron-dl
    downloadItems.add(item);
    totalBytes += item.getTotalBytes();

    const directory = options.directory || app.getPath('downloads');
    let filePath;
    if (options.filename) {
      filePath = path.join(directory, options.filename);
    } else {
      const filename = item.getFilename();
      const name = path.extname(filename)
        ? filename : getFilenameFromMime(filename, item.getMimeType());
      filePath = unusedFilename.sync(path.join(directory, name));
    }

    const errorMessage = options.errorMessage || 'The download of {filename} was interrupted';

    if (!options.saveAs) {
      item.setSavePath(filePath);
    }

    if (options.saveAs) {
      item.setSaveDialogOptions({ defaultPath: filePath });
    }

    if (typeof options.onStarted === 'function') {
      options.onStarted(item);
    }

    item.on('updated', () => {
      receivedBytes = [...downloadItems].reduce((receivedBytes_, item_) => {
        receivedBytes_ += item_.getReceivedBytes();
        return receivedBytes_;
      }, completedBytes);

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.badgeCount = activeDownloadItems();
      }

      if (!browserWindow.isDestroyed()) {
        browserWindow.setProgressBar(progressDownloadItems());
      }

      if (typeof options.onProgress === 'function') {
        const itemTransferredBytes = item.getReceivedBytes();
        const itemTotalBytes = item.getTotalBytes();

        options.onProgress({
          percent: itemTotalBytes ? itemTransferredBytes / itemTotalBytes : 0,
          transferredBytes: itemTransferredBytes,
          totalBytes: itemTotalBytes,
        });
      }
    });

    item.on('done', (_, state) => {
      completedBytes += item.getTotalBytes();
      downloadItems.delete(item);

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.badgeCount = activeDownloadItems();
      }

      if (!browserWindow.isDestroyed() && !activeDownloadItems()) {
        browserWindow.setProgressBar(-1);
        receivedBytes = 0;
        completedBytes = 0;
        totalBytes = 0;
      }

      if (options.unregisterWhenDone) {
        session.removeListener('will-download', willDownloadListener);
      }

      if (state === 'cancelled') {
        if (typeof options.onCancel === 'function') {
          options.onCancel(item);
        }
      } else if (state === 'interrupted') {
        const message = pupa(errorMessage, { filename: path.basename(item.getSavePath()) });
        callback(new Error(message));
      } else if (state === 'completed') {
        if (process.platform === 'darwin') {
          app.dock.downloadFinished(item.getSavePath());
        }

        if (options.openFolderWhenDone) {
          shell.showItemInFolder(item.getSavePath());
        }

        callback(null, item);
      }
    });
    /* electron-dl port end */
  };
  view.webContents.session.on('will-download', willDownloadListener);

  // Unread count badge
  if (unreadCountBadge) {
    view.webContents.usePageTitle = true;
    view.webContents.on('page-title-updated', (e, title) => {
      if (!view.webContents.usePageTitle) return;
      const num = getBadgeCountFromTitle(title);
      setWorkspaceBadgeCount(workspace.id, num, browserWindow);
    });
  }

  // Menu
  const contextMenuBuilder = new ContextMenuBuilder(
    view.webContents,
    true,
  );

  view.webContents.on('context-menu', (e, info) => {
    contextMenuBuilder.buildMenuForElement(info)
      .then((menu) => {
        if (info.linkURL && info.linkURL.length > 0) {
          menu.append(new MenuItem({ type: 'separator' }));

          menu.append(new MenuItem({
            label: 'Open Link in New Window',
            click: () => {
              // trigger the 'new-window' event manually
              handleNewWindow(
                {
                  sender: view.webContents,
                  preventDefault: () => {},
                },
                info.linkURL,
                '', // frameName
                'new-window',
              );
            },
          }));

          menu.append(new MenuItem({ type: 'separator' }));

          const workspaces = getWorkspaces();

          const workspaceLst = Object.values(workspaces).sort((a, b) => a.order - b.order);

          menu.append(new MenuItem({
            label: 'Open Link in New Workspace',
            click: () => {
              ipcMain.emit('request-open-url-in-workspace', null, info.linkURL);
            },
          }));
          menu.append(new MenuItem({ type: 'separator' }));

          workspaceLst.forEach((w) => {
            const workspaceName = w.name || `Workspace ${w.order + 1}`;
            menu.append(new MenuItem({
              label: `Open Link in ${workspaceName}`,
              click: () => {
                ipcMain.emit('request-open-url-in-workspace', null, info.linkURL, w.id);
              },
            }));
          });
        }

        menu.append(new MenuItem({ type: 'separator' }));

        menu.append(new MenuItem({
          label: 'Back',
          enabled: view.webContents.canGoBack(),
          click: () => {
            view.webContents.goBack();
          },
        }));
        menu.append(new MenuItem({
          label: 'Forward',
          enabled: view.webContents.canGoForward(),
          click: () => {
            view.webContents.goForward();
          },
        }));
        menu.append(new MenuItem({
          label: 'Reload',
          click: () => {
            view.webContents.reload();
          },
        }));

        menu.append(new MenuItem({ type: 'separator' }));

        menu.append(
          new MenuItem({
            label: 'More',
            submenu: [
              {
                label: 'About',
                click: () => ipcMain.emit('request-show-about-window'),
              },
              { type: 'separator' },
              {
                label: 'Check for Updates',
                click: () => ipcMain.emit('request-check-for-updates'),
              },
              {
                label: 'Preferences...',
                click: () => ipcMain.emit('request-show-preferences-window'),
              },
              { type: 'separator' },
              {
                label: 'WebCatalog Help',
                click: () => shell.openExternal('https://help.webcatalog.app?utm_source=juli_app'),
              },
              {
                label: 'WebCatalog Website',
                click: () => shell.openExternal('https://webcatalog.app?utm_source=juli_app'),
              },
              { type: 'separator' },
              {
                label: 'Quit',
                click: () => ipcMain.emit('request-quit'),
              },
            ],
          }),
        );

        menu.popup(browserWindow);
      });
  });

  // Find In Page
  view.webContents.on('found-in-page', (e, result) => {
    sendToAllWindows('update-find-in-page-matches', result.activeMatchOrdinal, result.matches);
  });

  // Link preview
  view.webContents.on('update-target-url', (e, url) => {
    try {
      view.webContents.send('update-target-url', url);
    } catch (err) {
      console.log(err); // eslint-disable-line no-console
    }
  });

  // Handle audio & notification preferences
  if (shouldMuteAudio !== undefined) {
    view.webContents.audioMuted = shouldMuteAudio;
  }
  view.webContents.once('did-stop-loading', () => {
    view.webContents.send('should-pause-notifications-changed', workspace.disableNotifications || shouldPauseNotifications);
  });

  views[workspace.id] = view;

  if (workspace.active) {
    browserWindow.setBrowserView(view);

    const contentSize = browserWindow.getContentSize();
    view.setBounds(getViewBounds(contentSize));
    view.setAutoResize({
      width: true,
      height: true,
    });
  }

  const initialUrl = (rememberLastPageVisited && workspace.lastUrl)
  || workspace.homeUrl || appJson.url;
  adjustUserAgentByUrl(view.webContents, initialUrl);
  if (initialUrl) {
    view.webContents.loadURL(initialUrl);
  }
};

const getView = (id) => views[id];

const setActiveView = (browserWindow, id) => {
  // stop find in page when switching workspaces
  const currentView = browserWindow.getBrowserView();
  if (currentView) {
    currentView.webContents.stopFindInPage('clearSelection');
    browserWindow.send('close-find-in-page');
  }

  if (views[id] == null) {
    addView(browserWindow, getWorkspace(id));
  } else {
    const view = views[id];
    browserWindow.setBrowserView(view);

    const contentSize = browserWindow.getContentSize();
    if (getWorkspaceMeta(id).didFailLoad) {
      view.setBounds(
        getViewBounds(contentSize, false, 0, 0),
      ); // hide browserView to show error message
    } else {
      view.setBounds(getViewBounds(contentSize));
    }
    view.setAutoResize({
      width: true,
      height: true,
    });

    // focus on webview
    // https://github.com/webcatalog/webcatalog-app/issues/398
    if (browserWindow.isFocused()) {
      view.webContents.focus();
    }

    sendToAllWindows('update-address', view.webContents.getURL(), false);
    sendToAllWindows('update-title', view.webContents.getTitle());
    browserWindow.setTitle(view.webContents.getTitle());
  }
};

const realignActiveView = (browserWindow, activeId) => {
  const view = browserWindow.getBrowserView();
  if (view && view.webContents) {
    const contentSize = browserWindow.getContentSize();
    if (getWorkspaceMeta(activeId).didFailLoad) {
      view.setBounds(
        getViewBounds(contentSize, false, 0, 0),
      ); // hide browserView to show error message
    } else {
      view.setBounds(getViewBounds(contentSize));
    }
  }
};

const removeView = (id) => {
  const view = views[id];
  if (view != null) {
    // end webContents so BrowserView can be cleaned with GC
    // https://github.com/electron/electron/pull/23578#issuecomment-703754455
    view.webContents.forcefullyCrashRenderer();
  }
  session.fromPartition(`persist:${id}`).clearStorageData();
  delete views[id];
};

const setViewsAudioPref = (_shouldMuteAudio) => {
  if (_shouldMuteAudio !== undefined) {
    shouldMuteAudio = _shouldMuteAudio;
  }
  const muteApp = getPreference('muteApp');
  Object.keys(views).forEach((id) => {
    const view = views[id];
    if (view != null) {
      const workspace = getWorkspace(id);
      view.webContents.audioMuted = workspace.disableAudio || shouldMuteAudio || muteApp;
    }
  });
};

const setViewsNotificationsPref = (_shouldPauseNotifications) => {
  if (_shouldPauseNotifications !== undefined) {
    shouldPauseNotifications = _shouldPauseNotifications;
  }
  Object.keys(views).forEach((id) => {
    const view = views[id];
    if (view != null) {
      const workspace = getWorkspace(id);
      view.webContents.send(
        'should-pause-notifications-changed',
        Boolean(workspace.disableNotifications || shouldPauseNotifications),
      );
    }
  });
};

const hibernateView = (id) => {
  const view = views[id];
  if (view != null) {
    // end webContents so BrowserView can be cleaned with GC
    // https://github.com/electron/electron/pull/23578#issuecomment-703754455
    view.webContents.forcefullyCrashRenderer();
  }
  delete views[id];
};

const reloadViewDarkReader = (id) => {
  const view = views[id];
  if (view != null) {
    view.webContents.send('reload-dark-reader');
  }
};

const reloadViewsDarkReader = () => {
  Object.keys(views).forEach((id) => {
    reloadViewDarkReader(id);
  });
};

const reloadViewsWebContentsIfDidFailLoad = () => {
  const metas = getWorkspaceMetas();
  Object.keys(metas).forEach((id) => {
    if (!metas[id].didFailLoad) return;

    const view = views[id];
    if (view != null) {
      view.webContents.reload();
    }
  });
};

const reloadView = (id) => {
  const view = views[id];
  if (view != null) {
    view.webContents.reload();
  }
};

// to be run before-quit
const destroyAllViews = () => {
  Object.keys(views)
    .filter((id) => views[id] != null)
    .forEach((id) => {
      views[id].webContents.forcefullyCrashRenderer();
      delete views[id];
    });
};

module.exports = {
  addView,
  getView,
  destroyAllViews,
  hibernateView,
  realignActiveView,
  reloadView,
  reloadViewDarkReader,
  reloadViewsDarkReader,
  reloadViewsWebContentsIfDidFailLoad,
  removeView,
  setActiveView,
  setViewsAudioPref,
  setViewsNotificationsPref,
};
