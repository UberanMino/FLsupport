/*
 * drive.js — save rendered WAVs straight into a Google Drive folder.
 *
 * Only available in the claude.ai Artifact build, where the page can call the
 * viewer's Google Drive connector through the `mcp` runtime capability. In the
 * standalone build `MPC.drive.available()` resolves false and the UI hides it.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const SERVER = 'Google Drive';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const LS_FOLDER = 'mpcstudio.drive.folder';
  const INLINE_LIMIT = 700 * 1024;   // raw bytes; base64 must stay under the 1 MiB call limit

  let mcpPromise = null;
  function mcp() {
    if (!mcpPromise) {
      mcpPromise = (window.claude && typeof window.claude.use === 'function')
        ? Promise.resolve().then(() => window.claude.use('mcp')).catch(() => null)
        : Promise.resolve(null);
    }
    return mcpPromise;
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  const folderIds = {};   // folder name -> id, for this page load

  function escapeQuery(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  // Turn an McpError into a sentence the viewer can act on.
  function explain(err) {
    const code = err && err.code;
    switch (code) {
      case 'needs_reauth': return 'Your Google Drive connection has expired. Reconnect Google Drive in claude.ai Settings → Connectors, then try again.';
      case 'server_not_connected': return 'Google Drive isn’t connected. Add it in claude.ai Settings → Connectors, then try again.';
      case 'selection_required': return 'You have more than one Google Drive connector. Pick one in the prompt claude.ai shows, then try again.';
      case 'not_in_manifest':
      case 'approval_required':
      case 'not_granted': return 'This page needs your permission to use Google Drive. Allow it when claude.ai asks, then try again.';
      case 'blocked_by_policy': return 'Your organization’s policy blocks saving to Google Drive from here.';
      case 'server_unavailable':
      case 'upstream_error': return 'Google Drive didn’t answer in time. The file may still have been saved, so check the folder before trying again.';
      case 'too_large': return err.message;
      case 'tool_error': return 'Google Drive refused the upload: ' + (err.message || 'unknown reason');
      default: return 'Saving to Google Drive failed' + (err && err.message ? ': ' + err.message : '.');
    }
  }

  async function findOrCreateFolder(api, name) {
    if (folderIds[name]) return folderIds[name];
    const q = "title = '" + escapeQuery(name) + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false";
    const found = await api.callTool(SERVER, 'search_files', { query: q, pageSize: 5, excludeContentSnippets: true }, { cache: false });
    const files = (found && found.payload && found.payload.files) || [];
    let id = files.length ? files[0].id : null;
    if (!id) {
      const created = await api.callTool(SERVER, 'create_file', { title: name, contentMimeType: FOLDER_MIME });
      id = created && created.payload && created.payload.id;
      if (!id) throw { code: 'tool_error', message: 'the folder was not created' };
    }
    folderIds[name] = id;
    return id;
  }

  function blobToBase64(blob) {
    return blob.arrayBuffer().then((ab) => MPC.util.abToBase64(ab));
  }

  const Drive = {
    SERVER,
    async available() {
      const api = await mcp();
      return !!api;
    },

    // Largest WAV (bytes) this view can upload, or Infinity-ish when the
    // viewer stages files for the call (16 MiB limit there).
    async maxBytes() {
      const api = await mcp();
      if (!api) return 0;
      try { if ((await api.listTools()).fileArgs) return 16 * 1048576; } catch (e) { /* inline only */ }
      return INLINE_LIMIT;
    },

    folderName() { return lsGet(LS_FOLDER) || 'FL Studio Samples'; },
    setFolderName(name) { lsSet(LS_FOLDER, name); },

    saveWav(blob, filename, folderName) { return Drive.saveFile(blob, filename, folderName, 'audio/wav'); },

    // Upload one file. Resolves { url } or rejects with { message }.
    async saveFile(blob, filename, folderName, mime) {
      mime = mime || blob.type || 'application/octet-stream';
      const api = await mcp();
      if (!api) throw { message: 'Saving to Google Drive only works in the claude.ai version of this page.' };
      try {
        const parentId = await findOrCreateFolder(api, folderName);
        const fileArgs = (await Drive.maxBytes()) > INLINE_LIMIT;
        let content;
        if (fileArgs) {
          content = { $file: { data: blob, name: filename, type: mime } };
        } else if (blob.size <= INLINE_LIMIT) {
          content = await blobToBase64(blob);
        } else {
          throw { code: 'too_large', message: 'This file is ' + (blob.size / 1048576).toFixed(1) + ' MB. This view can only send about ' + Math.round(INLINE_LIMIT / 1024) + ' KB to Drive, so try a shorter take or download it instead.' };
        }
        const res = await api.callTool(SERVER, 'create_file', {
          title: filename,
          parentId,
          base64Content: content,
          contentMimeType: mime,
          disableConversionToGoogleType: true,
        });
        const p = (res && res.payload) || {};
        return { url: p.viewUrl || null, folderId: parentId };
      } catch (err) {
        // A stale cached folder id (folder deleted) should not stick around.
        if (err && err.code === 'tool_error') delete folderIds[folderName];
        throw { message: explain(err) };
      }
    },
  };

  MPC.drive = Drive;
})();
