import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { accountName, hidingIdentity } from './privacy.js';
import { runtime } from '../runtime.js';
import { abandonAdd, finishAdd, listAccounts, reauth, saveIdentity, startAdd, } from '../accounts/service.js';
import { PROVIDERS } from '../providers/types.js';
import { TextInput } from './TextInput.js';
import { Clickable } from './terminal/clicks.js';
import { checkJevKey } from '../decider/jev.js';
import { deleteJevKey, getJevKey, setJevKey } from '../store/secrets.js';
/** What each "+ Add …" row adds. */
const ADD_LABEL = (item) => ({
    'claude:': 'Claude subscription (Pro / Max)',
    'claude:console': 'Claude API key (Anthropic Console, pay per use)',
    'claude:bedrock': 'Claude on Amazon Bedrock (your AWS credentials)',
    'claude:vertex': 'Claude on Google Vertex AI (your Google Cloud credentials)',
    'codex:': 'Codex with ChatGPT (Plus / Pro / Business)',
    'codex:openai': 'Codex with an OpenAI API key (pay per use)',
}[`${item.provider}:${item.api ?? ''}`] ?? `${PROVIDERS[item.provider].name} account`);
const cloudForm = (api) => ({
    provider: 'claude',
    api,
    index: 0,
    values: {},
    fields: api === 'bedrock'
        ? [
            { key: 'region', label: 'AWS region', hint: 'e.g. us-east-1' },
            { key: 'profile', label: 'AWS profile', hint: 'from ~/.aws/config; enter for the default credentials', optional: true },
        ]
        : [
            { key: 'projectId', label: 'Google Cloud project ID', hint: 'the project with Claude enabled in Vertex AI' },
            { key: 'region', label: 'Region', hint: 'e.g. us-east5, or global' },
        ],
});
export function LoginScreen({ onLog, onClose, bare }) {
    const [rows, setRows] = useState();
    const [cursor, setCursor] = useState(0);
    const [mode, setMode] = useState({ name: 'list' });
    const [busy, setBusy] = useState();
    const [jevSet, setJevSet] = useState(false);
    useEffect(() => {
        void getJevKey().then((k) => setJevSet(!!k));
    }, []);
    const saveJev = async (key) => {
        const trimmed = key.trim();
        if (!trimmed)
            return setMode({ name: 'list' });
        setBusy('Checking Jev key…');
        try {
            const models = await checkJevKey(trimmed);
            const where = await setJevKey(trimmed);
            setJevSet(true);
            onLog('info', `Jev key saved (${where === 'keychain' ? 'macOS Keychain' : '~/.rein/secrets, 0600'})${models.length ? ` · models: ${models.join(', ')}` : ''}. Pick Jev as the decision model in /model.`);
        }
        catch (err) {
            onLog('error', `Jev key rejected: ${err.message}`);
        }
        finally {
            setBusy(undefined);
            setMode({ name: 'list' });
        }
    };
    const loginRef = useRef(undefined);
    const reload = useCallback(async () => {
        setRows(await listAccounts());
    }, []);
    useEffect(() => {
        void reload();
    }, [reload]);
    // Cancel an in-flight login if the screen unmounts.
    useEffect(() => () => loginRef.current?.flow.cancel(), []);
    const items = [
        ...(rows ?? []).map((row) => ({ kind: 'account', row })),
        { kind: 'add', provider: 'claude' },
        { kind: 'add', provider: 'claude', api: 'console' },
        { kind: 'add', provider: 'claude', api: 'bedrock' },
        { kind: 'add', provider: 'claude', api: 'vertex' },
        { kind: 'add', provider: 'codex' },
        { kind: 'add', provider: 'codex', api: 'openai' },
        { kind: 'jev' },
    ];
    const runLogin = useCallback(async (login) => {
        loginRef.current = login;
        setMode({ name: 'login', login });
        const update = (patch) => {
            Object.assign(login, patch);
            setMode({ name: 'login', login: { ...login } });
        };
        let finished = false;
        for await (const ev of login.flow.events) {
            if (ev.type === 'url')
                update({ url: ev.url });
            else if (ev.type === 'needsCode')
                update({ needsCode: true });
            else if (ev.type === 'error')
                update({ error: ev.message, needsCode: false });
            else if (ev.type === 'done') {
                finished = true;
                try {
                    if (login.isNew) {
                        const saved = await finishAdd(login.account, ev.status);
                        onLog('info', `Added ${PROVIDERS[saved.provider].name} account ${accountName(saved)} (${saved.plan ?? 'unknown plan'})`);
                    }
                    else {
                        await saveIdentity(login.account, ev.status);
                        onLog('info', `Re-authenticated ${accountName(login.account)}`);
                    }
                }
                catch (err) {
                    onLog('error', err.message);
                }
            }
        }
        loginRef.current = undefined;
        if (!finished && login.isNew)
            await abandonAdd(login.account);
        if (!finished && login.error)
            onLog('error', `Login failed: ${login.error}`);
        setMode({ name: 'list' });
        await reload();
    }, [onLog, reload]);
    const select = async (item) => {
        if (item.kind === 'account')
            setMode({ name: 'actions', row: item.row, cursor: 0 });
        else if (item.kind === 'jev')
            setMode(jevSet ? { name: 'jevActions', cursor: 0 } : { name: 'jevInput' });
        else if (item.kind === 'add') {
            if (item.api === 'bedrock' || item.api === 'vertex')
                return setMode({ name: 'cloud', form: cloudForm(item.api) });
            setBusy('Starting login…');
            const { account, flow } = await startAdd(item.provider, item.api ? { api: item.api } : undefined);
            setBusy(undefined);
            void runLogin({ account, flow, isNew: true, needsCode: false });
        }
    };
    /** One Bedrock / Vertex field answered: next field, or check the setup. */
    const answerCloud = async (form, value) => {
        const field = form.fields[form.index];
        if (!value.trim() && !field.optional)
            return;
        const values = { ...form.values, ...(value.trim() ? { [field.key]: value.trim() } : {}) };
        if (form.index + 1 < form.fields.length)
            return setMode({ name: 'cloud', form: { ...form, index: form.index + 1, values } });
        setBusy('Checking…');
        const { account, flow } = await startAdd(form.provider, { api: form.api, apiConfig: values });
        setBusy(undefined);
        void runLogin({ account, flow, isNew: true, needsCode: false });
    };
    const accountAction = (row, idx) => {
        const action = ['reauth', 'remove', 'back'][idx];
        if (action === 'reauth') {
            if (row.account.imported)
                setMode({ name: 'confirmReauth', row });
            else
                void runLogin({ account: row.account, flow: reauth(row.account), isNew: false, needsCode: false });
        }
        else if (action === 'remove')
            setMode({ name: 'confirmRemove', row });
        else
            setMode({ name: 'list' });
    };
    const confirmRemove = (row) => {
        const { account } = row;
        setBusy('Removing…');
        void runtime.removeAccount(account).then(async () => {
            onLog('info', `Removed ${accountName(account)}${account.imported ? ' (unregistered; your CLI login is untouched)' : ''}`);
            await reload();
            setCursor(0);
            setBusy(undefined);
            setMode({ name: 'list' });
        });
    };
    const jevAction = (idx) => {
        const action = ['replace', 'remove', 'back'][idx];
        if (action === 'replace')
            setMode({ name: 'jevInput' });
        else if (action === 'remove') {
            void deleteJevKey().then(() => {
                setJevSet(false);
                onLog('info', 'Jev key removed. Decisions fall back to the cheapest model.');
                setMode({ name: 'list' });
            });
        }
        else
            setMode({ name: 'list' });
    };
    useInput((input, key) => {
        if (busy)
            return;
        if (mode.name === 'list') {
            if (key.escape || input === 'q')
                onClose();
            else if (key.upArrow)
                setCursor((c) => Math.max(0, c - 1));
            else if (key.downArrow)
                setCursor((c) => Math.min(items.length - 1, c + 1));
            else if (key.return && items[cursor])
                void select(items[cursor]);
        }
        else if (mode.name === 'actions') {
            const actions = ['reauth', 'remove', 'back'];
            if (key.escape)
                setMode({ name: 'list' });
            else if (key.upArrow)
                setMode({ ...mode, cursor: Math.max(0, mode.cursor - 1) });
            else if (key.downArrow)
                setMode({ ...mode, cursor: Math.min(actions.length - 1, mode.cursor + 1) });
            else if (key.return)
                accountAction(mode.row, mode.cursor);
        }
        else if (mode.name === 'confirmRemove') {
            if (input === 'y')
                confirmRemove(mode.row);
            else if (input === 'n' || key.escape)
                setMode({ name: 'list' });
        }
        else if (mode.name === 'confirmReauth') {
            if (input === 'y')
                void runLogin({ account: mode.row.account, flow: reauth(mode.row.account), isNew: false, needsCode: false });
            else if (input === 'n' || key.escape)
                setMode({ name: 'list' });
        }
        else if (mode.name === 'jevActions') {
            const actions = ['replace', 'remove', 'back'];
            if (key.escape)
                setMode({ name: 'list' });
            else if (key.upArrow)
                setMode({ ...mode, cursor: Math.max(0, mode.cursor - 1) });
            else if (key.downArrow)
                setMode({ ...mode, cursor: Math.min(actions.length - 1, mode.cursor + 1) });
            else if (key.return)
                jevAction(mode.cursor);
        }
        else if (mode.name === 'login') {
            if (key.escape && !mode.login.needsCode)
                mode.login.flow.cancel();
        }
    }, { isActive: !(mode.name === 'login' && mode.login.needsCode) && mode.name !== 'jevInput' && mode.name !== 'cloud' });
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 }), children: [!bare && _jsx(Text, { bold: true, children: "Accounts" }), busy && _jsx(Text, { dimColor: true, children: busy }), mode.name === 'login' ? (_jsx(LoginView, { login: mode.login })) : rows === undefined ? (_jsx(Text, { dimColor: true, children: "Checking logins\u2026" })) : (_jsx(ItemList, { items: items, cursor: cursor, active: mode.name === 'list', jevSet: jevSet, onPick: (i) => {
                    if (busy || !items[i])
                        return;
                    setCursor(i);
                    void select(items[i]);
                } })), mode.name === 'actions' && _jsx(ActionMenu, { row: mode.row, cursor: mode.cursor, onPick: (i) => accountAction(mode.row, i) }), mode.name === 'confirmReauth' && (_jsxs(Text, { color: "yellow", children: ["Re-authenticate ", accountName(mode.row.account), "? This signs in your normal", ' ', PROVIDERS[mode.row.account.provider].name, " CLI login too. (y/n)"] })), mode.name === 'cloud' && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: mode.form.api === 'bedrock' ? 'Claude on Amazon Bedrock' : 'Claude on Google Vertex AI' }), _jsx(Text, { dimColor: true, children: mode.form.api === 'bedrock'
                            ? 'Uses your AWS credentials (profile, environment or SSO); Rein stores no keys.'
                            : 'Uses your Google Cloud credentials (gcloud auth application-default login); Rein stores no keys.' }), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { children: [mode.form.fields[mode.form.index].label, ": "] }), _jsx(TextInput, { placeholder: mode.form.fields[mode.form.index].hint, onSubmit: (v) => void answerCloud(mode.form, v), onCancel: () => setMode({ name: 'list' }) }, mode.form.index)] })] })), mode.name === 'jevInput' && (_jsxs(Box, { children: [_jsx(Text, { children: "Jev API key: " }), _jsx(TextInput, { mask: true, placeholder: "paste key from typesafe.ai", onSubmit: (k) => void saveJev(k), onCancel: () => setMode({ name: 'list' }) })] })), mode.name === 'jevActions' && (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: ['Replace key', 'Remove key', 'Back'].map((l, i) => (_jsx(Clickable, { onClick: () => jevAction(i), children: _jsxs(Text, { color: i === mode.cursor ? 'cyan' : undefined, children: [i === mode.cursor ? '❯ ' : '  ', l] }) }, l))) })), mode.name === 'confirmRemove' && (_jsxs(Text, { color: "yellow", children: ["Remove ", accountName(mode.row.account), "?", ' ', mode.row.account.imported
                        ? 'Rein will forget it; your normal CLI login stays.'
                        : 'Rein will log it out and delete its config dir.', ' ', "(y/n)"] })), (mode.name === 'confirmRemove' || mode.name === 'confirmReauth') && (_jsxs(Box, { children: [_jsx(Clickable, { onClick: () => mode.name === 'confirmRemove'
                            ? confirmRemove(mode.row)
                            : void runLogin({ account: mode.row.account, flow: reauth(mode.row.account), isNew: false, needsCode: false }), children: _jsx(Text, { color: "green", children: "[ yes ]" }) }), _jsx(Text, { children: " " }), _jsx(Clickable, { onClick: () => setMode({ name: 'list' }), children: _jsx(Text, { color: "red", children: "[ no ]" }) })] })), _jsx(Text, { dimColor: true, children: mode.name === 'login'
                    ? mode.login.needsCode
                        ? `paste the ${mode.login.account.api === 'openai' ? 'key' : 'code'} and press enter · esc cancels`
                        : 'waiting for browser… · esc cancels'
                    : 'click or ↑↓ select · enter open · esc close' })] }));
}
function ItemList({ items, cursor, active, jevSet, onPick }) {
    return (_jsx(Box, { flexDirection: "column", marginY: 1, children: items.map((item, i) => (_jsx(Clickable, { onClick: () => active && onPick(i), children: _jsx(ItemRow, { item: item, pointer: active && i === cursor ? '❯ ' : '  ', highlighted: active && i === cursor, jevSet: jevSet }) }, item.kind === 'account' ? item.row.account.id : item.kind === 'add' ? `add-${item.provider}-${item.api ?? ''}` : 'jev'))) }));
}
function ItemRow({ item, pointer, highlighted, jevSet }) {
    if (item.kind === 'account')
        return _jsx(AccountLine, { pointer: pointer, row: item.row });
    if (item.kind === 'add') {
        return (_jsxs(Text, { color: highlighted ? 'cyan' : undefined, children: [pointer, "+ Add ", ADD_LABEL(item)] }));
    }
    return (_jsxs(Text, { color: highlighted ? 'cyan' : undefined, children: [pointer, jevSet ? (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, children: 'Jev'.padEnd(7) }), "API key ", _jsx(Text, { color: "green", children: "\u25CF set" })] })) : ('+ Add Jev API key (decisions)')] }));
}
function AccountLine({ row, pointer }) {
    const { account, status } = row;
    const email = hidingIdentity() ? accountName(account) : ((status.loggedIn ? status.email : undefined) ?? account.email ?? account.id);
    const plan = (status.loggedIn ? status.plan : undefined) ?? account.plan;
    return (_jsxs(Text, { children: [pointer, _jsx(Text, { bold: true, children: PROVIDERS[account.provider].name.padEnd(7) }), email, plan ? _jsxs(Text, { dimColor: true, children: [" \u00B7 ", plan] }) : null, account.imported ? _jsx(Text, { dimColor: true, children: " \u00B7 imported" }) : null, '  ', status.loggedIn ? (_jsx(Text, { color: "green", children: "\u25CF signed in" })) : (_jsxs(Text, { color: "red", children: ["\u25CF signed out", status.error ? ` (${status.error.slice(0, 60)})` : ''] }))] }));
}
function ActionMenu({ row, cursor, onPick }) {
    const labels = ['Re-authenticate', row.account.imported ? 'Remove from Rein' : 'Log out & remove', 'Back'];
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsx(Text, { dimColor: true, children: accountName(row.account) }), labels.map((l, i) => (_jsx(Clickable, { onClick: () => onPick(i), children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, children: [i === cursor ? '❯ ' : '  ', l] }) }, l)))] }));
}
function LoginView({ login }) {
    const provider = PROVIDERS[login.account.provider].name;
    return (_jsxs(Box, { flexDirection: "column", marginY: 1, children: [_jsxs(Text, { children: ["Signing in to ", provider, login.isNew ? ` (new account ${login.account.id})` : '', "\u2026"] }), login.url ? (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "If the browser didn't open, visit:" }), _jsx(Text, { color: "cyan", children: login.url })] })) : (_jsxs(Text, { dimColor: true, children: ["Starting ", provider, " login\u2026"] })), login.needsCode && (_jsxs(Box, { marginTop: 1, children: [_jsx(Text, { children: login.account.api === 'openai' ? 'OpenAI API key: ' : 'Code: ' }), _jsx(TextInput, { mask: true, placeholder: login.account.api === 'openai' ? 'paste your key from platform.openai.com (Codex stores it, not Rein)' : 'paste the code from the browser', onSubmit: (c) => login.flow.submitCode(c), onCancel: () => login.flow.cancel() })] })), login.error && _jsx(Text, { color: "red", children: login.error })] }));
}
