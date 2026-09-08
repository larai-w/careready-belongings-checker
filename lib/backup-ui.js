import { readBackupState, restoreBackupState } from '../storage.js';
import { BACKUP_KEYS, MAX_BACKUP_BYTES, makeBackup, parseBackup, backupSummary } from './backup.js';

export function setupBackup() {
    const $ = id => document.getElementById(id);
    const status = $('backup-status');
    const dialog = $('backup-dialog');
    let pending = null;
    let busy = false;
    let reading = false;
    const message = value => { status.textContent = value; };
    const close = () => { if (!busy) { pending = null; dialog.close(); } };
    if (window.location.hash === '#backup-restored') {
        message('復元しました。行き先を選んで、持ち物とチェックを確認してください。');
        window.history.replaceState(null, '', '#backup');
    }
    $('backup-export').disabled = false;
    $('backup-file').disabled = false;
    $('backup-export').addEventListener('click', async () => {
        $('backup-export').disabled = true;
        try {
            const backup = makeBackup(await readBackupState(BACKUP_KEYS));
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            if (blob.size > MAX_BACKUP_BYTES) throw new Error('バックアップが2MBを超えています。');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'careready-backup-' + backup.createdAt.slice(0, 10) + '.json';
            a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
            message('保存用ファイルを作りました。端末のダウンロード先を確認してください。');
        } catch (e) { message(e.message || 'バックアップを作れませんでした。'); }
        finally { $('backup-export').disabled = false; }
    });
    $('backup-file').addEventListener('change', async event => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file || reading || busy) return;
        reading = true; pending = null;
        try {
            if (file.size > MAX_BACKUP_BYTES) throw new Error('2MB以下のバックアップを選んでください。');
            const backup = parseBackup(await file.text());
            const expected = await readBackupState(BACKUP_KEYS);
            pending = { backup, expected };
            $('backup-summary').textContent = backupSummary(backup.data);
            $('backup-current').textContent = '現在の端末：' + backupSummary(makeBackup(expected).data);
            $('backup-date').textContent = 'ファイル作成日時：' + new Date(backup.createdAt).toLocaleString('ja-JP');
            $('backup-error').textContent = '';
            dialog.showModal();
        } catch (e) { message(e.message || 'ファイルを読み込めませんでした。'); }
        finally { reading = false; }
    });
    $('backup-cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else pending = null; });
    $('backup-confirm').addEventListener('click', async () => {
        if (!pending || busy) return;
        busy = true;
        $('backup-confirm').disabled = true; $('backup-cancel').disabled = true;
        try {
            await restoreBackupState(pending.backup.data, pending.expected);
            pending = null;
            message('復元しました。画面を読み直します。');
            window.history.replaceState(null, '', '#backup-restored');
            window.location.reload();
        } catch (e) { $('backup-error').textContent = e.message || '復元できませんでした。元データを確認してください。'; }
        finally { busy = false; $('backup-confirm').disabled = false; $('backup-cancel').disabled = false; }
    });
}
