import {Box, Text} from 'ink';
import {TextInput} from './TextInput.js';

/** `/vault set NAME`: the value is typed here, hidden, and goes straight into the vault (never the chat). */
export function VaultPrompt({secret, onSave, onCancel}: {secret: string; onSave(value: string): void; onCancel(): void}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>The agent can use it as ${secret} in shell commands, but never sees the value. Esc cancels.</Text>
      <Box marginTop={1}>
        <Text>{secret}: </Text>
        <TextInput mask placeholder="paste or type the value" onSubmit={(v) => (v ? onSave(v) : onCancel())} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
