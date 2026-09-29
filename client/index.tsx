import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { LocaleRuntime, Translate } from '@deepseek-ai/dsh-client-locale/client';
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client';
import {
  Button,
  IconFolderClose16,
  IconPlusOutline16,
  Input,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  isDirectoryPickerUnavailable,
  probeLocalBrowse,
  windowsDriveAnchors,
  type LocalAnchor,
} from './local-browse.js';
import TYPERT_REMOTE from './typert.remote-client.js';

export const name = 'dsh-ssh-remote-client';
export const inject = ['locale', 'remote'];

const ZH = {
  'Add workspace': '添加工作区',
  'Close': '关闭',
  'Choose a local folder or SSH host': '选择本机文件夹或 SSH 主机',
  'Cancel': '取消',
  'Open this folder': '打开此文件夹',
  'Adding...': '正在添加…',
  'Local': '本机',
  'Local files': '本机文件',
  'Host': '主机',
  'Home': '主目录',
  'Detecting Windows drives...': '检测 Windows 盘…',
  'Hidden': '隐藏',
  'This directory has no child folders.': '此目录没有子文件夹。',
  'Showing the first 1000 directories.': '仅显示前 1000 个目录。',
  'New folder name': '新建文件夹名称',
  'New': '新建',
  'Use the system folder picker': '使用系统文件夹选择器',
  'Browse the Host filesystem in the app (including Windows drives under /mnt)': '在应用内浏览 Host 文件系统（含 /mnt 下的 Windows 盘）',
  'No concrete Host is available in ~/.ssh/config.': '~/.ssh/config 中没有可用的具体 Host。',
  'SSH connections': 'SSH 连接',
  'Connections use local OpenSSH; the versioned helper unifies remote files, processes, and PTY.': '连接由本机 OpenSSH 建立；版本化 helper 统一远端文件、进程和 PTY。',
  'No concrete SSH Host alias found.': '没有发现具体 SSH Host alias。',
  'Please create this file, add a concrete Host, and refresh.': '请创建该文件并添加具体 Host 后刷新。',
  'Not handshaken yet': '尚未握手',
  'Identity configured': '已配置 Identity',
  'Still have old DSH hosts as SFTP compatibility fallback; migrate them to': '仍有旧 DSH host 仅作为 SFTP 兼容兜底；请迁移到',
  'Remote workspace validation': '远程工作区验证',
  'Workspace creation': '工作区创建',
  'Workspace naming': '工作区命名',
  'Remote folder creation': '远程文件夹创建',
  'Local folder creation': '本机文件夹创建',
  'Disconnected': '未连接',
  'Installing': '正在安装',
  'Connecting': '正在连接',
  'Connected': '已连接',
  'Connected (limited capabilities)': '已连接（能力受限）',
  'Reconnecting': '正在重连',
  'Error': '错误',
  'Waiting for handshake': '等待握手',
} as const;

const EN = Object.fromEntries(Object.keys(ZH).map(key => [key, key])) as Record<string, string>;

function registerTranslations(locale: LocaleRuntime): () => void {
  const unregisterZh = locale.register('ssh-remote', 'zh', ZH as Record<string, string>);
  const unregisterEn = locale.register('ssh-remote', 'en', EN);
  return () => {
    unregisterEn();
    unregisterZh();
  };
}

function usePluginTranslator(locale: LocaleRuntime): Translate {
  useSyncExternalStore(locale.subscribe.bind(locale), locale.getSnapshot.bind(locale));
  return locale.bind('ssh-remote');
}

interface DiscoveredHost {
  alias: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
  proxyJump: string;
  proxyCommand: string;
  helper: HelperHostStatus;
}

interface HelperHostStatus {
  status: 'disconnected' | 'installing' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'error';
  version: string;
  sessionId: string;
  capabilities: Record<string, unknown>;
  error: string;
}

interface HelperHostDiagnostics extends HelperHostStatus {
  alias: string;
  helperSha256: string;
  lastConnectedAt: number;
  lastHealthAt: number;
  nextRetryAt: number;
  stderr: string;
  assetPath: string;
}

interface SshConfig {
  configPath: string;
  configExists: boolean;
  hosts: DiscoveredHost[];
  legacyHostCount: number;
}

interface RemoteDirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

interface RemoteDirectoryListing {
  path: string;
  home: string;
  crumbs: RemoteDirectoryEntry[];
  entries: RemoteDirectoryEntry[];
  truncated: boolean;
}

interface SshWorkspaceAnchor {
  anchorPath: string;
  uri: string;
  alias: string;
  remotePath: string;
  title: string;
  createdAt: number;
}

type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } };

const MUTATION_DEADLINE_MS = 30_000;

interface SshRemote {
  config(): Promise<RemoteResult<SshConfig>>;
  statuses(): Promise<RemoteResult<Record<string, HelperHostStatus>>>;
  browse(alias: string, path: string): Promise<RemoteResult<RemoteDirectoryListing>>;
  createDirectory(alias: string, parent: string, name: string): Promise<RemoteResult<string>>;
  materializeWorkspace(alias: string, path: string): Promise<RemoteResult<SshWorkspaceAnchor>>;
  connectHost(alias: string): Promise<RemoteResult<HelperHostStatus>>;
  disconnectHost(alias: string): Promise<RemoteResult<HelperHostStatus>>;
  retryHost(alias: string): Promise<RemoteResult<HelperHostStatus>>;
  diagnostics(alias: string): Promise<RemoteResult<HelperHostDiagnostics>>;
}

interface DirectoryService {
  pickDirectory(): Promise<string | null>;
  listDirectory(path?: string): Promise<RemoteDirectoryListing>;
  createDirectory(path: string, name: string): Promise<string>;
}

export async function apply(ctx: ClientContext) {
  const unregisterTranslations = registerTranslations(ctx.locale);
  const disposeMount = await ctx.remote.$mount(TYPERT_REMOTE);
  const ui = ctx.inject(['remote.sshRemote', 'slots', 'workspaces'], (scope) => {
    const mountUi = (scope: ClientContext, directories: DirectoryService) => {
      const ssh = scope.remote.sshRemote;
      const flowInject = () => ({
        ssh,
        locale: ctx.locale,
        pickLocal: () => directories.pickDirectory(),
        // The composed picker's browse capability (in-app listing/creation).
        // Served only when the host composes the `-browse` backend; chooseLocal
        // probes for it and falls back to the native chooser only on the
        // explicit capability-unavailable signal (`directory-picker-unavailable`).
        listLocal: (path?: string) => directories.listDirectory(path),
        createLocalDirectory: (path: string, name: string) =>
          directories.createDirectory(path, name),
        createWorkspace: (input: { path: string }) => scope.workspaces.create(input),
        renameWorkspace: (workspaceId: WorkspaceId, title: string) =>
          scope.workspaces.rename(workspaceId, title),
      });

      return scope.slots.inject('settings.plugins.tab', () =>
        scope.slots.inject('conversation.hero.workspace.directoryFlow', () =>
          scope.slots.inject('sidebar.workspaces.directoryFlow', function* () {
            yield scope.slots.register(
              {
                name: 'settings.plugins.tab',
                id: 'ssh-remote',
                order: 20,
                label: () => 'SSH Remote',
                inject: () => ({ ssh, locale: ctx.locale }),
              },
              SshRemotePanel,
            );
            // The slot is `single`; a lower priority shadows the stock local-only
            // occupant while this combined local/SSH flow is mounted.
            yield scope.slots.register(
              {
                name: 'conversation.hero.workspace.directoryFlow',
                priority: -100,
                inject: flowInject,
              },
              SshDirectoryFlow,
            );
            yield scope.slots.register(
              {
                name: 'sidebar.workspaces.directoryFlow',
                priority: -100,
                inject: flowInject,
              },
              SshDirectoryFlow,
            );
          }),
        ),
      );
    };
    // DSH 0.1.5 split directory UI operations from the Workspace controller.
    // Read the new service only inside its own injection scope; rc.2 still
    // supplies these operations on workspaces and needs no extra dependency.
    if (typeof scope.workspaces.pickDirectory === 'function') {
      return mountUi(scope, scope.workspaces);
    }
    const directories = scope.inject(['uiWorkspace'], next => mountUi(
      next,
      (next as ClientContext & { uiWorkspace: DirectoryService }).uiWorkspace,
    ));
    return () => directories.dispose();
  });

  try {
    await ui;
  } catch (error) {
    await ui.dispose();
    await disposeMount();
    throw error;
  }

  return async () => {
    await ui.dispose();
    await disposeMount();
    unregisterTranslations();
  };
}

/** Which filesystem the combined dialog is currently browsing. */
type BrowseTarget = { kind: 'local' } | { kind: 'ssh'; alias: string };

type SshDirectoryFlowProps = DirectoryFlowOwnerProps & {
  ssh: SshRemote;
  locale: LocaleRuntime;
  pickLocal: () => Promise<string | null>;
  /** One local directory level via the composed picker's browse capability. */
  listLocal: (path?: string) => Promise<RemoteDirectoryListing>;
  /** Create one child directory under an existing local parent. */
  createLocalDirectory: (path: string, name: string) => Promise<string>;
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>;
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<WorkspaceView>;
};

/** Wrap a throwing service call into the dialog's result envelope. */
async function asResult<T>(run: () => Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (reason) {
    return { ok: false, error: { message: messageOf(reason) } };
  }
}

/** Bound non-cancellable host RPCs so a wedged transport cannot lock the dialog forever. */
function withMutationDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} 超过 ${MUTATION_DEADLINE_MS / 1000} 秒；结果未知，请刷新后核对。`)));
    }, MUTATION_DEADLINE_MS);
    operation.then(
      value => finish(() => resolve(value)),
      reason => finish(() => reject(reason)),
    );
  });
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function SshDirectoryFlow({
  open,
  busy,
  onPicked,
  onCancel,
  onError,
  ssh,
  locale,
  pickLocal,
  listLocal,
  createLocalDirectory,
  createWorkspace,
  renameWorkspace,
}: SshDirectoryFlowProps) {
  const t = usePluginTranslator(locale);
  const [config, setConfig] = useState<SshConfig | null>(null);
  const [target, setTarget] = useState<BrowseTarget | null>(null);
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  /** Irreversible host-side operation in flight; user cancellation is gated. */
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState('');
  const [newFolder, setNewFolder] = useState('');
  // Tri-state browse-capability probe result: null while unknown.
  const [localCanBrowse, setLocalCanBrowse] = useState<boolean | null>(null);
  // Windows drive anchors derived from one /mnt listing; null until probed.
  const [driveAnchors, setDriveAnchors] = useState<LocalAnchor[] | null>(null);
  /** Latest navigation request; stale remote replies may not overwrite it. */
  const navigationEpoch = useRef(0);
  /** Owns the mutation busy flag even if navigation/open state changes. */
  const mutationEpoch = useRef(0);

  useEffect(() => {
    if (!open) return;
    const epoch = ++navigationEpoch.current;
    setConfig(null);
    setTarget(null);
    setListing(null);
    setError('');
    setNewFolder('');
    setDriveAnchors(null);
    setLocalCanBrowse(null);
    setLoading(true);
    void Promise.all([
      ssh.config().catch(error => ({
        ok: false as const,
        error: { message: messageOf(error) },
      })),
      probeLocalBrowse(() => listLocal()).then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
      ),
    ]).then(([configResult, browseProbe]) => {
      if (navigationEpoch.current !== epoch) return;
      if (browseProbe.ok) setLocalCanBrowse(browseProbe.value);
      else {
        // Non-capability probe failures (permission, timeout, transport,
        // internal…) surface only after the request epoch is still current.
        setError(`本机浏览探测失败：${messageOf(browseProbe.error)}`);
      }
      if (configResult.ok) setConfig(configResult.value);
      else if (browseProbe.ok) setError(configResult.error.message);
    }).finally(() => {
      if (navigationEpoch.current === epoch) setLoading(false);
    });
    return () => {
      if (navigationEpoch.current === epoch) navigationEpoch.current += 1;
    };
  }, [open, ssh, listLocal]);

  useEffect(() => {
    if (!open || target?.kind !== 'local' || driveAnchors !== null) return;
    const epoch = navigationEpoch.current;
    let cancelled = false;
    void asResult(() => listLocal('/mnt')).then((result) => {
      if (!cancelled && navigationEpoch.current === epoch) {
        setDriveAnchors(result.ok ? windowsDriveAnchors(result.value.entries) : []);
      }
    });
    return () => { cancelled = true; };
  }, [open, target, driveAnchors, listLocal]);

  /**
   * One raw local browse call that preserves any thrown error so callers can
   * still distinguish the explicit capability-unavailable signal from real
   * browse failures.
   */
  async function browseLocalRaw(path?: string): Promise<
    { ok: true; value: RemoteDirectoryListing } | { ok: false; error: unknown }
  > {
    try {
      return { ok: true, value: await listLocal(path) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function enter(targetNext: BrowseTarget, path?: string): Promise<boolean> {
    const epoch = ++navigationEpoch.current;
    setLoading(true);
    setError('');
    if (targetNext.kind === 'ssh') {
      let result: RemoteResult<RemoteDirectoryListing>;
      try {
        result = await ssh.browse(targetNext.alias, path ?? '');
      } catch (reason) {
        if (navigationEpoch.current === epoch) {
          setError(messageOf(reason));
          setLoading(false);
        }
        return false;
      }
      if (navigationEpoch.current !== epoch) return false;
      if (result.ok) {
        setTarget(targetNext);
        setListing(result.value);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
      return result.ok;
    }
    const outcome = await browseLocalRaw(path);
    if (navigationEpoch.current !== epoch) return false;
    if (outcome.ok) {
      setTarget(targetNext);
      setListing(outcome.value);
    } else {
      setError(messageOf(outcome.error));
    }
    setLoading(false);
    return outcome.ok;
  }

  function navigate(path?: string): void {
    if (target) void enter(target, path);
  }

  async function chooseLocal() {
    // Prefer the composed browse capability — it works headless and covers
    // the WSL host filesystem together with its /mnt Windows drives. Only
    // the explicit capability-unavailable signal may switch to the OS
    // chooser: the probe reported `false`, or a raced browse call now
    // reports `directory-picker-unavailable`. Permission, timeout, transport,
    // internal, and every other failure stays in the dialog for retry, with
    // no native fallback.
    if (localCanBrowse !== false) {
      const epoch = ++navigationEpoch.current;
      setLoading(true);
      setError('');
      const outcome = await browseLocalRaw();
      if (navigationEpoch.current !== epoch) return;
      if (outcome.ok) {
        setLoading(false);
        setTarget({ kind: 'local' });
        setListing(outcome.value);
        return;
      }
      if (!isDirectoryPickerUnavailable(outcome.error)) {
        setError(messageOf(outcome.error));
        setLoading(false);
        return;
      }
      // Capability raced: the composition now serves native (or no picker) —
      // the one condition that may reach the OS chooser.
      setLocalCanBrowse(false);
      setLoading(false);
    }
    await pickLocalFallback();
  }

  /** The only native-chooser path, entered solely on the explicit unavailable signal. */
  async function pickLocalFallback() {
    const epoch = ++navigationEpoch.current;
    setLoading(true);
    setError('');
    try {
      const path = await pickLocal();
      if (navigationEpoch.current === epoch && path) onPicked(path);
    } catch (reason) {
      if (navigationEpoch.current === epoch) setError(messageOf(reason));
    } finally {
      if (navigationEpoch.current === epoch) setLoading(false);
    }
  }

  async function commit() {
    if (!target || !listing) return;
    const epoch = ++navigationEpoch.current;
    const mutation = ++mutationEpoch.current;
    setMutating(true);
    if (target.kind === 'local') {
      setMutating(false);
      onPicked(listing.path);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await withMutationDeadline(
        ssh.materializeWorkspace(target.alias, listing.path),
        t('Remote workspace validation'),
      );
      if (navigationEpoch.current !== epoch) return;
      if (result.ok) {
        // The stock owner accepts only a path and initially derives the title
        // from its basename. Pre-create idempotently, apply the clean remote
        // title, then hand the same path back so the owner keeps its normal
        // close/select/error lifecycle without exposing the anchor hash.
        const workspace = await withMutationDeadline(
          createWorkspace({ path: result.value.anchorPath }),
            t('Workspace creation'),
        );
        if (navigationEpoch.current !== epoch) return;
        if (workspace.title !== result.value.title) {
          await withMutationDeadline(
            renameWorkspace(workspace.workspaceId, result.value.title),
            t('Workspace naming'),
          );
          if (navigationEpoch.current !== epoch) return;
        }
        onPicked(result.value.anchorPath);
      } else {
        onError(result.error.message);
      }
    } catch (reason) {
      if (navigationEpoch.current === epoch) onError(messageOf(reason));
    } finally {
      if (navigationEpoch.current === epoch) setLoading(false);
      if (mutationEpoch.current === mutation) setMutating(false);
    }
  }

  async function createFolder() {
    if (!target || !listing || !newFolder.trim()) return;
    const epoch = ++navigationEpoch.current;
    const mutation = ++mutationEpoch.current;
    const targetSnapshot = target;
    const listingPath = listing.path;
    const folderName = newFolder.trim();
    setLoading(true);
    setMutating(true);
    setError('');
    try {
      const created = targetSnapshot.kind === 'ssh'
        ? await withMutationDeadline(
          ssh.createDirectory(targetSnapshot.alias, listingPath, folderName),
          t('Remote folder creation'),
        )
        : await asResult(() => withMutationDeadline(
          createLocalDirectory(listingPath, folderName),
          t('Local folder creation'),
        ));
      if (navigationEpoch.current !== epoch) return;
      if (created.ok) {
        setNewFolder('');
        await enter(targetSnapshot, created.value);
      } else {
        setError(created.error.message);
        setLoading(false);
      }
    } catch (reason) {
      if (navigationEpoch.current === epoch) {
        setError(messageOf(reason));
        setLoading(false);
      }
    } finally {
      if (mutationEpoch.current === mutation) setMutating(false);
    }
  }

  function cancel(): void {
    navigationEpoch.current += 1;
    onCancel();
  }

  // Modal renders null while closed; `disabled` only gates the open dialog.
  const disabled = loading || busy || mutating;

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy && !mutating) cancel(); }}
      // The Modal card defaults to min(380px, 100%) (confirm-dialog size);
      // plugins ship no stylesheet, so one scoped rule widens the card for
      // the browse layout.
      className="dsh-ssh-remote-flow"
      title={!target ? t('Add workspace') : target.kind === 'local' ? t('Local files') : `SSH · ${target.alias}`}
      closeLabel={t('Close')}
      description={listing ? listing.path : t('Choose a local folder or SSH host')}
      footer={
        <>
          <Button variant="ghost" disabled={busy || mutating} onClick={cancel}>{t('Cancel')}</Button>
          {target && listing && (
            <Button variant="primary" disabled={disabled} onClick={() => void commit()}>
              {busy ? t('Adding...') : t('Open this folder')}
            </Button>
          )}
        </>
      }
    >
      <style>{'.dsh-ssh-remote-flow{width:min(880px,94vw)}'}</style>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!target || !listing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void chooseLocal()}
              style={sourceRowStyle}
            >
              <strong>{t('Local')}</strong>
              <span style={subtleText}>
                {localCanBrowse === false
                  ? t('Use the system folder picker')
                  : t('Browse the Host filesystem in the app (including Windows drives under /mnt)')}
              </span>
            </Button>
            <div style={hostListStyle}>
              {config?.hosts.map((host) => (
                <Button
                  key={host.alias}
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void enter({ kind: 'ssh', alias: host.alias })}
                  style={sourceRowStyle}
                >
                  <strong>{host.alias}</strong>
                  <span style={subtleText}>
                    {host.user ? `${host.user}@` : ''}{host.host}:{host.port}
                  </span>
                  <span style={dimmedText}>
                    Helper · {helperStateLabel(host.helper.status, t)}
                    {host.helper.version ? ` · ${host.helper.version}` : ''}
                  </span>
                  {host.helper.error && <span style={{ ...dimmedText, color: 'var(--dsw-alias-label-error)' }}>{host.helper.error}</span>}
                </Button>
              ))}
              {!loading && config?.hosts.length === 0 && (
                <div style={subtleText}>{t('No concrete Host is available in ~/.ssh/config.')}</div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div style={chipRowStyle}>
              <Pill disabled={disabled} onClick={() => { setTarget(null); setListing(null); }}>
                {target.kind === 'local' ? t('Local') : t('Host')}
              </Pill>
              {listing.crumbs.map((crumb) => (
                <Pill key={crumb.path} disabled={disabled} onClick={() => navigate(crumb.path)}>
                  {crumb.name}
                </Pill>
              ))}
            </div>
            {target.kind === 'local' && (
              <div style={chipRowStyle}>
                <Pill disabled={disabled} onClick={() => navigate(listing.home)}>{t('Home')}</Pill>
                {(driveAnchors ?? []).map((anchor) => (
                  <Pill key={anchor.path} disabled={disabled} onClick={() => navigate(anchor.path)}>
                    {anchor.label}
                  </Pill>
                ))}
                {driveAnchors === null && <span style={subtleText}>{t('Detecting Windows drives...')}</span>}
              </div>
            )}
            <div style={entryListStyle}>
              {listing.entries.map((entry) => (
                <Button
                  key={entry.path}
                  variant="ghost"
                  size="sm"
                  icon={<IconFolderClose16 />}
                  disabled={disabled}
                  onClick={() => navigate(entry.path)}
                  style={entryRowStyle}
                >
                  <span>{entry.name}</span>
                  {entry.hidden && <span style={{ marginLeft: 'auto', ...dimmedText }}>{t('Hidden')}</span>}
                </Button>
              ))}
              {!loading && listing.entries.length === 0 && (
                <div style={{ padding: 16, ...dimmedText }}>{t('This directory has no child folders.')}</div>
              )}
            </div>
            {listing.truncated && <div style={{ fontSize: 12, ...dimmedText }}>{t('Showing the first 1000 directories.')}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  value={newFolder}
                  disabled={disabled}
                  onChange={(event) => setNewFolder(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createFolder();
                  }}
                  placeholder={t('New folder name')}
                />
              </div>
              <Button
                variant="ghost"
                icon={<IconPlusOutline16 />}
                disabled={disabled || !newFolder.trim()}
                onClick={() => void createFolder()}
              >
                {t('New')}
              </Button>
            </div>
          </>
        )}

        {error && <div role="alert" style={{ color: 'var(--dsw-alias-label-error)', fontSize: 12 }}>{error}</div>}
      </div>
    </Modal>
  );
}

const sourceRowStyle: CSSProperties = {
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  height: 'auto',
  padding: '10px 14px',
};

const chipRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

const entryListStyle: CSSProperties = {
  maxHeight: 320,
  overflowY: 'auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 2,
  padding: 6,
};

// The host/source picker list mirrors the directory list: bounded height so a
// large ~/.ssh/config cannot push the footer actions off-screen. "本机" stays
// pinned above it; only the SSH hosts scroll.
const hostListStyle: CSSProperties = {
  maxHeight: 'min(50vh, 420px)',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  // Keep clickable buttons clear of the scrollbar gutter.
  paddingRight: 4,
};

const entryRowStyle: CSSProperties = { justifyContent: 'flex-start', flexShrink: 0 };

const subtleText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
const dimmedText: CSSProperties = { color: 'var(--dsw-alias-label-dimmed)', fontSize: 11 };

function helperStateLabel(state: HelperHostStatus['status'], t: Translate): string {
  return ({
    disconnected: t('Disconnected'),
    installing: t('Installing'),
    connecting: t('Connecting'),
    connected: t('Connected'),
    degraded: t('Connected (limited capabilities)'),
    reconnecting: t('Reconnecting'),
    error: t('Error'),
  } as const)[state];
}

function helperCapabilitySummary(capabilities: Record<string, unknown>, t: Translate): string {
  const names = Object.entries(capabilities)
    .filter(([, value]) => value !== false && value !== null)
    .map(([name]) => name);
  return names.length === 0 ? t('Waiting for handshake') : names.join(' · ');
}

function SshRemotePanel({ ssh, locale }: { ssh: SshRemote; locale: LocaleRuntime }) {
  const t = usePluginTranslator(locale);
  const [config, setConfig] = useState<SshConfig | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyAlias, setBusyAlias] = useState('');
  const [details, setDetails] = useState<HelperHostDiagnostics | null>(null);
  const epoch = useRef(0);

  async function load(showLoading = true) {
    const request = ++epoch.current;
    if (showLoading) setLoading(true);
    try {
      const result = await ssh.config();
      if (epoch.current !== request) return;
      if (result.ok) {
        setConfig(result.value);
        setError('');
      } else setError(result.error.message);
    } catch (reason) {
      if (epoch.current === request) setError(messageOf(reason));
    } finally {
      if (showLoading && epoch.current === request) setLoading(false);
    }
  }

  async function loadStatuses() {
    try {
      const result = await ssh.statuses();
      if (!result.ok) return;
      setConfig(current => current === null ? current : {
        ...current,
        hosts: current.hosts.map(host => ({
          ...host,
          helper: result.value[host.alias] ?? host.helper,
        })),
      });
    } catch {
      // The full refresh button remains the explicit diagnostic surface.
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void loadStatuses(); }, 5_000);
    return () => {
      clearInterval(timer);
      epoch.current += 1;
    };
  }, [ssh]);

  async function runHostAction(
    alias: string,
    action: 'connect' | 'disconnect' | 'retry' | 'diagnostics',
  ): Promise<void> {
    setBusyAlias(alias);
    setError('');
    try {
      const result = action === 'connect'
        ? await ssh.connectHost(alias)
        : action === 'disconnect'
          ? await ssh.disconnectHost(alias)
          : action === 'retry'
            ? await ssh.retryHost(alias)
            : await ssh.diagnostics(alias);
      if (!result.ok) setError(result.error.message);
      else if (action === 'diagnostics') setDetails(result.value as HelperHostDiagnostics);
      await load(false);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyAlias('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 12, maxWidth: 760 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0 }}>{t('SSH connections')}</h3>
          <div style={{ marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            {t('Connections use local OpenSSH; the versioned helper unifies remote files, processes, and PTY.')} 
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={loading || Boolean(busyAlias)} onClick={() => void load()}>
          {loading ? t('Refreshing...') : t('Refresh')}
        </Button>
      </div>

      {config && (
        <div style={{ padding: 10, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
          <div style={subtleText}>SSH config</div>
          <code style={{ fontSize: 12 }}>{config.configPath}</code>
          {!config.configExists && <div style={{ marginTop: 6, ...subtleText }}>{t('Please create this file, add a concrete Host, and refresh.')}</div>}
        </div>
      )}

      {config?.hosts.length === 0 && config.configExists && <div style={subtleText}>{t('No concrete SSH Host alias found.')}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {config?.hosts.map((host) => {
          const busy = busyAlias === host.alias;
          const connected = host.helper.status === 'connected' || host.helper.status === 'degraded';
          return (
            <div key={host.alias} style={{ padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{host.alias}</div>
                <span style={{ ...dimmedText, color: host.helper.status === 'error' ? 'var(--dsw-alias-label-error)' : undefined }}>
                  {helperStateLabel(host.helper.status, t)}
                </span>
              </div>
              <div style={{ ...subtleText, overflowWrap: 'anywhere' }}>
                {host.user ? `${host.user}@` : ''}{host.host}:{host.port}
              </div>
              <div style={{ marginTop: 6, ...dimmedText }}>
                Helper {host.helper.version || t('Not handshaken yet')} · {helperCapabilitySummary(host.helper.capabilities, t)}
              </div>
              {host.helper.error && <div style={{ marginTop: 6, color: 'var(--dsw-alias-label-error)', fontSize: 12 }}>{host.helper.error}</div>}
              {(host.proxyJump || host.proxyCommand || host.identityFile) && (
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {host.proxyJump && <Pill>ProxyJump: {host.proxyJump}</Pill>}
                  {host.proxyCommand && <Pill>ProxyCommand</Pill>}
                  {host.identityFile && <Pill>{t('Identity configured')}</Pill>}
                </div>
              )}
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {connected ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void runHostAction(host.alias, 'disconnect')}>
                    {busy ? t('Working...') : t('Disconnect')}
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void runHostAction(host.alias, 'connect')}>
                    {busy ? t('Working...') : t('Connect')}
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void runHostAction(host.alias, 'retry')}>{t('Retry')}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runHostAction(host.alias, 'diagnostics')}>{t('Diagnostics')}</Button>
              </div>
            </div>
          );
        })}
      </div>

      {details && (
        <div style={{ padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong>{details.alias} · {t('Diagnostics')}</strong>
            <Button size="sm" variant="ghost" onClick={() => setDetails(null)}>{t('Close diagnostics')}</Button>
          </div>
          <pre style={{ margin: '8px 0 0', maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify(details, null, 2)}
          </pre>
        </div>
      )}

      {config && config.legacyHostCount > 0 && (
        <div style={subtleText}>
          {t('Still have old DSH hosts as SFTP compatibility fallback; migrate them to')} <code>{config.configPath}</code>。
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--dsw-alias-label-error)' }}>{error}</div>}
    </div>
  );
}
