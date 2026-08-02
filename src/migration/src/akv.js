// akv.js — read watch-credential secrets from Azure Key Vault.
//
// Auth is DefaultAzureCredential: locally this uses your `az login` session (or
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET if set); in a managed
// environment it uses the managed identity. Same credential the Python backends
// use (src/stride_storage/azure/credentials.py).

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

/** @returns {SecretClient} */
export function makeSecretClient(vaultUrl) {
  if (!vaultUrl) throw new Error("AKV_VAULT_URL is required");
  return new SecretClient(vaultUrl, new DefaultAzureCredential());
}

/**
 * List the names of enabled secrets whose name starts with `${prefix}-`.
 * Disabled/expired secrets are skipped.
 *
 * @returns {Promise<string[]>}
 */
export async function listSecretNames(client, prefix) {
  const head = `${prefix}-`;
  const names = [];
  for await (const props of client.listPropertiesOfSecrets()) {
    if (!props.name || !props.name.startsWith(head)) continue;
    if (props.enabled === false) continue;
    names.push(props.name);
  }
  names.sort();
  return names;
}

/**
 * Fetch the current value of a secret.
 *
 * @returns {Promise<string>} the raw secret value (a JSON string)
 */
export async function getSecretValue(client, name) {
  const secret = await client.getSecret(name);
  if (secret.value == null) {
    throw new Error(`secret "${name}" has no value`);
  }
  return secret.value;
}
