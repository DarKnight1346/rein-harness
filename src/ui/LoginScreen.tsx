import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {accountName, hidingIdentity} from './privacy.js';
import {runtime} from '../runtime.js';
import {
  abandonAdd,
  finishAdd,
  listAccounts,
  reauth,
  saveIdentity,
  startAdd,
  type AccountRow,
} from '../accounts/service.js';
import {PROVIDERS, type Account, type LoginFlow, type ProviderId} from '../providers/types.js';
import {TextInput} from './TextInput.js';
import {Clickable} from './terminal/clicks.js';
import {checkJevKey} from '../decider/jev.js';
import {deleteJevKey, getJevKey, setJevKey} from '../store/secrets.js';

type Props = {
  onLog(kind: 'info' | 'error', text: string): void;
  onClose(): void;
  /** Inside a fullscreen Window: no own border/title. */
  bare?: boolean;
};

type Item =
  | {kind: 'account'; row: AccountRow}
  | {kind: 'add'; provider: ProviderId}
  | {kind: 'jev'};

type LoginState = {
  account: Account;
  flow: LoginFlow;
  isNew: boolean;
  url?: string;
  needsCode: boolean;
  error?: string;
};

type Mode =
  | {name: 'list'}
  | {name: 'actions'; row: AccountRow; cursor: number}
  | {name: 'confirmRemove'; row: AccountRow}
  | {name: 'confirmReauth'; row: AccountRow}
  | {name: 'jevInput'}
  | {name: 'jevActions'; cursor: number}
  | {name: 'login'; login: LoginState};

export function LoginScreen({onLog, onClose, bare}: Props) {
  const [rows, setRows] = useState<AccountRow[] | undefined>();
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({name: 'list'});
  const [busy, setBusy] = useState<string | undefined>();
  const [jevSet, setJevSet] = useState(false);
  useEffect(() => {
    void getJevKey().then((k) => setJevSet(!!k));
  }, []);

  const saveJev = async (key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return setMode({name: 'list'});
    setBusy('Checking Jev key…');
    try {
      const models = await checkJevKey(trimmed);
      const where = await setJevKey(trimmed);
      setJevSet(true);
      onLog('info', `Jev key saved (${where === 'keychain' ? 'macOS Keychain' : '~/.rein/secrets, 0600'})${models.length ? ` · models: ${models.join(', ')}` : ''}. Pick Jev as the decision model in /model.`);
    } catch (err) {
      onLog('error', `Jev key rejected: ${(err as Error).message}`);
    } finally {
      setBusy(undefined);
      setMode({name: 'list'});
    }
  };
  const loginRef = useRef<LoginState | undefined>(undefined);

  const reload = useCallback(async () => {
    setRows(await listAccounts());
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Cancel an in-flight login if the screen unmounts.
  useEffect(() => () => loginRef.current?.flow.cancel(), []);

  const items: Item[] = [
    ...(rows ?? []).map((row) => ({kind: 'account', row}) as const),
    {kind: 'add', provider: 'claude'},
    {kind: 'add', provider: 'codex'},
    {kind: 'jev'},
  ];

  const runLogin = useCallback(
    async (login: LoginState) => {
      loginRef.current = login;
      setMode({name: 'login', login});
      const update = (patch: Partial<LoginState>) => {
        Object.assign(login, patch);
        setMode({name: 'login', login: {...login}});
      };
      let finished = false;
      for await (const ev of login.flow.events) {
        if (ev.type === 'url') update({url: ev.url});
        else if (ev.type === 'needsCode') update({needsCode: true});
        else if (ev.type === 'error') update({error: ev.message, needsCode: false});
        else if (ev.type === 'done') {
          finished = true;
          try {
            if (login.isNew) {
              const saved = await finishAdd(login.account, ev.status);
              onLog('info', `Added ${PROVIDERS[saved.provider].name} account ${accountName(saved)} (${saved.plan ?? 'unknown plan'})`);
            } else {
              await saveIdentity(login.account, ev.status);
              onLog('info', `Re-authenticated ${accountName(login.account)}`);
            }
          } catch (err) {
            onLog('error', (err as Error).message);
          }
        }
      }
      loginRef.current = undefined;
      if (!finished && login.isNew) await abandonAdd(login.account);
      if (!finished && login.error) onLog('error', `Login failed: ${login.error}`);
      setMode({name: 'list'});
      await reload();
    },
    [onLog, reload],
  );

  const select = async (item: Item) => {
    if (item.kind === 'account') setMode({name: 'actions', row: item.row, cursor: 0});
    else if (item.kind === 'jev') setMode(jevSet ? {name: 'jevActions', cursor: 0} : {name: 'jevInput'});
    else if (item.kind === 'add') {
      setBusy('Starting login…');
      const {account, flow} = await startAdd(item.provider);
      setBusy(undefined);
      void runLogin({account, flow, isNew: true, needsCode: false});
    }
  };

  const accountAction = (row: AccountRow, idx: number) => {
    const action = (['reauth', 'remove', 'back'] as const)[idx];
    if (action === 'reauth') {
      if (row.account.imported) setMode({name: 'confirmReauth', row});
      else void runLogin({account: row.account, flow: reauth(row.account), isNew: false, needsCode: false});
    } else if (action === 'remove') setMode({name: 'confirmRemove', row});
    else setMode({name: 'list'});
  };
  const confirmRemove = (row: AccountRow) => {
    const {account} = row;
    setBusy('Removing…');
    void runtime.removeAccount(account).then(async () => {
      onLog('info', `Removed ${accountName(account)}${account.imported ? ' (unregistered; your CLI login is untouched)' : ''}`);
      await reload();
      setCursor(0);
      setBusy(undefined);
      setMode({name: 'list'});
    });
  };
  const jevAction = (idx: number) => {
    const action = (['replace', 'remove', 'back'] as const)[idx];
    if (action === 'replace') setMode({name: 'jevInput'});
    else if (action === 'remove') {
      void deleteJevKey().then(() => {
        setJevSet(false);
        onLog('info', 'Jev key removed. Decisions fall back to the cheapest model.');
        setMode({name: 'list'});
      });
    } else setMode({name: 'list'});
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (mode.name === 'list') {
        if (key.escape || input === 'q') onClose();
        else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
        else if (key.return && items[cursor]) void select(items[cursor]!);
      } else if (mode.name === 'actions') {
        const actions = ['reauth', 'remove', 'back'] as const;
        if (key.escape) setMode({name: 'list'});
        else if (key.upArrow) setMode({...mode, cursor: Math.max(0, mode.cursor - 1)});
        else if (key.downArrow) setMode({...mode, cursor: Math.min(actions.length - 1, mode.cursor + 1)});
        else if (key.return) accountAction(mode.row, mode.cursor);
      } else if (mode.name === 'confirmRemove') {
        if (input === 'y') confirmRemove(mode.row);
        else if (input === 'n' || key.escape) setMode({name: 'list'});
      } else if (mode.name === 'confirmReauth') {
        if (input === 'y') void runLogin({account: mode.row.account, flow: reauth(mode.row.account), isNew: false, needsCode: false});
        else if (input === 'n' || key.escape) setMode({name: 'list'});
      } else if (mode.name === 'jevActions') {
        const actions = ['replace', 'remove', 'back'] as const;
        if (key.escape) setMode({name: 'list'});
        else if (key.upArrow) setMode({...mode, cursor: Math.max(0, mode.cursor - 1)});
        else if (key.downArrow) setMode({...mode, cursor: Math.min(actions.length - 1, mode.cursor + 1)});
        else if (key.return) jevAction(mode.cursor);
      } else if (mode.name === 'login') {
        if (key.escape && !mode.login.needsCode) mode.login.flow.cancel();
      }
    },
    {isActive: !(mode.name === 'login' && mode.login.needsCode) && mode.name !== 'jevInput'},
  );

  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1})}>
      {!bare && <Text bold>Accounts</Text>}
      {busy && <Text dimColor>{busy}</Text>}
      {mode.name === 'login' ? (
        <LoginView login={mode.login} />
      ) : rows === undefined ? (
        <Text dimColor>Checking logins…</Text>
      ) : (
        <ItemList
          items={items}
          cursor={cursor}
          active={mode.name === 'list'}
          jevSet={jevSet}
          onPick={(i) => {
            if (busy || !items[i]) return;
            setCursor(i);
            void select(items[i]!);
          }}
        />
      )}
      {mode.name === 'actions' && <ActionMenu row={mode.row} cursor={mode.cursor} onPick={(i) => accountAction(mode.row, i)} />}
      {mode.name === 'confirmReauth' && (
        <Text color="yellow">
          Re-authenticate {accountName(mode.row.account)}? This signs in your normal{' '}
          {PROVIDERS[mode.row.account.provider].name} CLI login too. (y/n)
        </Text>
      )}
      {mode.name === 'jevInput' && (
        <Box>
          <Text>Jev API key: </Text>
          <TextInput mask placeholder="paste key from typesafe.ai" onSubmit={(k) => void saveJev(k)} onCancel={() => setMode({name: 'list'})} />
        </Box>
      )}
      {mode.name === 'jevActions' && (
        <Box flexDirection="column" marginBottom={1}>
          {['Replace key', 'Remove key', 'Back'].map((l, i) => (
            <Clickable key={l} onClick={() => jevAction(i)}>
              <Text color={i === mode.cursor ? 'cyan' : undefined}>
                {i === mode.cursor ? '❯ ' : '  '}
                {l}
              </Text>
            </Clickable>
          ))}
        </Box>
      )}
      {mode.name === 'confirmRemove' && (
        <Text color="yellow">
          Remove {accountName(mode.row.account)}?{' '}
          {mode.row.account.imported
            ? 'Rein will forget it; your normal CLI login stays.'
            : 'Rein will log it out and delete its config dir.'}{' '}
          (y/n)
        </Text>
      )}
      {(mode.name === 'confirmRemove' || mode.name === 'confirmReauth') && (
        <Box>
          <Clickable
            onClick={() =>
              mode.name === 'confirmRemove'
                ? confirmRemove(mode.row)
                : void runLogin({account: mode.row.account, flow: reauth(mode.row.account), isNew: false, needsCode: false})
            }
          >
            <Text color="green">[ yes ]</Text>
          </Clickable>
          <Text> </Text>
          <Clickable onClick={() => setMode({name: 'list'})}>
            <Text color="red">[ no ]</Text>
          </Clickable>
        </Box>
      )}
      <Text dimColor>
        {mode.name === 'login'
          ? mode.login.needsCode
            ? 'paste the code and press enter · esc cancels'
            : 'waiting for browser… · esc cancels'
          : 'click or ↑↓ select · enter open · esc close'}
      </Text>
    </Box>
  );
}

function ItemList({items, cursor, active, jevSet, onPick}: {items: Item[]; cursor: number; active: boolean; jevSet: boolean; onPick(i: number): void}) {
  return (
    <Box flexDirection="column" marginY={1}>
      {items.map((item, i) => (
        <Clickable key={item.kind === 'account' ? item.row.account.id : item.kind === 'add' ? `add-${item.provider}` : 'jev'} onClick={() => active && onPick(i)}>
          <ItemRow item={item} pointer={active && i === cursor ? '❯ ' : '  '} highlighted={active && i === cursor} jevSet={jevSet} />
        </Clickable>
      ))}
    </Box>
  );
}

function ItemRow({item, pointer, highlighted, jevSet}: {item: Item; pointer: string; highlighted: boolean; jevSet: boolean}) {
  if (item.kind === 'account') return <AccountLine pointer={pointer} row={item.row} />;
  if (item.kind === 'add') {
    return (
      <Text color={highlighted ? 'cyan' : undefined}>
        {pointer}+ Add {PROVIDERS[item.provider].name} account
      </Text>
    );
  }
  return (
    <Text color={highlighted ? 'cyan' : undefined}>
      {pointer}
      {jevSet ? (
        <>
          <Text bold>{'Jev'.padEnd(7)}</Text>API key <Text color="green">● set</Text>
        </>
      ) : (
        '+ Add Jev API key (decisions)'
      )}
    </Text>
  );
}

function AccountLine({row, pointer}: {row: AccountRow; pointer: string}) {
  const {account, status} = row;
  const email = hidingIdentity() ? accountName(account) : ((status.loggedIn ? status.email : undefined) ?? account.email ?? account.id);
  const plan = (status.loggedIn ? status.plan : undefined) ?? account.plan;
  return (
    <Text>
      {pointer}
      <Text bold>{PROVIDERS[account.provider].name.padEnd(7)}</Text>
      {email}
      {plan ? <Text dimColor> · {plan}</Text> : null}
      {account.imported ? <Text dimColor> · imported</Text> : null}
      {'  '}
      {status.loggedIn ? (
        <Text color="green">● signed in</Text>
      ) : (
        <Text color="red">● signed out{status.error ? ` (${status.error.slice(0, 60)})` : ''}</Text>
      )}
    </Text>
  );
}

function ActionMenu({row, cursor, onPick}: {row: AccountRow; cursor: number; onPick(i: number): void}) {
  const labels = ['Re-authenticate', row.account.imported ? 'Remove from Rein' : 'Log out & remove', 'Back'];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{accountName(row.account)}</Text>
      {labels.map((l, i) => (
        <Clickable key={l} onClick={() => onPick(i)}>
          <Text color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            {l}
          </Text>
        </Clickable>
      ))}
    </Box>
  );
}

function LoginView({login}: {login: LoginState}) {
  const provider = PROVIDERS[login.account.provider].name;
  return (
    <Box flexDirection="column" marginY={1}>
      <Text>Signing in to {provider}{login.isNew ? ` (new account ${login.account.id})` : ''}…</Text>
      {login.url ? (
        <>
          <Text dimColor>If the browser didn't open, visit:</Text>
          <Text color="cyan">{login.url}</Text>
        </>
      ) : (
        <Text dimColor>Starting {provider} login…</Text>
      )}
      {login.needsCode && (
        <Box marginTop={1}>
          <Text>Code: </Text>
          <TextInput mask placeholder="paste the code from the browser" onSubmit={(c) => login.flow.submitCode(c)} onCancel={() => login.flow.cancel()} />
        </Box>
      )}
      {login.error && <Text color="red">{login.error}</Text>}
    </Box>
  );
}
