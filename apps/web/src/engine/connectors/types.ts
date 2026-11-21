/**
 * The read side of the engine's credential store as the connectors see it. The implementation (browser storage, unencrypted,
 * set from the UI) lives with the credentials module; connectors take this interface so they stay testable with a plain object.
 * Keys are the credential keys of the app (`ll2Token`).
 */
export interface CredentialSource {
  get(key: string): Promise<string | undefined>;
}
