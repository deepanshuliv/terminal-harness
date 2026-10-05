import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS_MODELS } from './modelsAndProviders';
import { createOpenRouterClient } from './openrouter';

const SESSION_FILE_PATH = `${process.cwd()}/database.json`;

type PROVIDERS_TYPES = keyof typeof PROVIDERS_MODELS;
type MODELS_SUPPORTED_TYPE =
  (typeof PROVIDERS_MODELS)[keyof typeof PROVIDERS_MODELS][number];

type AllSessionDetailsType = Partial<Record<PROVIDERS_TYPES, PersistedSession>>;

let allSessionDetails: AllSessionDetailsType = {};

interface PersistedSession {
  apiKey: string;
  model: MODELS_SUPPORTED_TYPE;
  active: boolean;
}

export interface CurrentSessionProvider {
  apiKey: string;
  model: MODELS_SUPPORTED_TYPE;
  client: GoogleGenAI | OpenAI | Anthropic;
  provider: PROVIDERS_TYPES;
}

const currentSessionProvider: CurrentSessionProvider | null = null;
interface upsertProviderInSessionInputType {
  apiKey?: string;
  active?: boolean;
  model?: MODELS_SUPPORTED_TYPE;
}
async function upsertProviderInSession(
  provider: PROVIDERS_TYPES,
  options: upsertProviderInSessionInputType,
) {
  const model = options.model ?? PROVIDERS_MODELS[provider][0];

  try {
    const data = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
    const parsedData = JSON.parse(data) as AllSessionDetailsType;
    if (parsedData[provider]) {
      if (options.apiKey) {
        parsedData[provider].apiKey = options.apiKey;
      }
      if (model) {
        parsedData[provider].model = model;
      }
      if (options.active) {
        Object.entries(parsedData).forEach(([currProvider, providerInfo]) => {
          if (currProvider !== provider && providerInfo.active === true) {
            providerInfo.active = false;
          } else if (
            currProvider === provider &&
            providerInfo.active === true
          ) {
            providerInfo.active = options.active!;
          }
        });
        parsedData[provider].active = options.active;
      }
    } else {
      if (options.apiKey) {
        parsedData[provider] = {
          apiKey: options.apiKey,
          model: model,
          active: false,
        };
      } else {
        throw Error('Appropriate provider is not available');
      }
    }

    await writeAllSessionDetailsToFile(parsedData);
  } catch (error) {
    if (options.apiKey) {
      allSessionDetails[provider] = {
        active: true,
        apiKey: options.apiKey,
        model: model,
      };
      await writeAllSessionDetailsToFile(allSessionDetails);
    } else {
      throw error;
    }
  }
}

async function createClient(
  apiKey: string,
  provider: string,
): Promise<GoogleGenAI | OpenAI | Anthropic> {
  let client: GoogleGenAI | OpenAI | Anthropic | null = null;
  if (apiKey && provider === 'google') {
    client = new GoogleGenAI({ apiKey });
  } else if (apiKey && provider === 'openai') {
    client = new OpenAI({ apiKey });
  } else if (apiKey && provider === 'openrouter') {
    client = createOpenRouterClient(apiKey);
  } else if (apiKey && provider === 'claude') {
    client = new Anthropic({
      apiKey,
    });
  }
  if (!client)
    throw Error(`provider "${provider.toUpperCase()}" client failed create`);
  return client;
}

// database.json holds API keys, so it is kept readable by the owner only.
// (`mode` applies when the file is created; chmod covers existing files.)
// For unattended use prefer RELAY_PROVIDER + the provider's key variable,
// which writes no credentials to disk.
const SESSION_FILE_MODE = 0o600;

async function writeAllSessionDetailsToFile(session: AllSessionDetailsType) {
  const content = JSON.stringify(session);
  try {
    await fs.writeFile(SESSION_FILE_PATH, content, { mode: SESSION_FILE_MODE });
    await fs.chmod(SESSION_FILE_PATH, SESSION_FILE_MODE);
  } catch (error) {
    throw Error(
      `Failed to save session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Shows enough of a secret to recognise it, never the whole value. */
function maskSecret(secret: string): string {
  if (secret.length <= 12) return '****';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

async function updateProviderModel(
  provider: PROVIDERS_TYPES,
  model: MODELS_SUPPORTED_TYPE,
) {
  const data = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
  const parsedData = JSON.parse(data) as AllSessionDetailsType;

  parsedData[provider]!.model = model;

  await writeAllSessionDetailsToFile(parsedData);
}

async function getAllSessions(): Promise<AllSessionDetailsType> {
  const data = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
  const currentSessionProviders = JSON.parse(data) as AllSessionDetailsType;

  if (!currentSessionProviders) {
    throw Error('first login and provide provider , no provider is present');
  }
  return currentSessionProviders;
}

const PROVIDER_API_KEY_ENVS: Record<PROVIDERS_TYPES, string> = {
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// Non-interactive environments (CI, benchmark containers) can select the
// provider through RELAY_PROVIDER / RELAY_MODEL and the provider's standard
// API key variable, so no credentials are written to database.json.
async function getSessionFromEnv(): Promise<CurrentSessionProvider | null> {
  const provider = process.env.RELAY_PROVIDER as PROVIDERS_TYPES | undefined;
  if (!provider) return null;
  if (!PROVIDERS_MODELS[provider]) {
    throw Error(`RELAY_PROVIDER "${provider}" is not supported`);
  }
  const apiKey = process.env[PROVIDER_API_KEY_ENVS[provider]];
  if (!apiKey) {
    throw Error(`${PROVIDER_API_KEY_ENVS[provider]} is not set`);
  }
  const model = (process.env.RELAY_MODEL ||
    PROVIDERS_MODELS[provider][0]) as MODELS_SUPPORTED_TYPE;
  return {
    apiKey,
    model,
    provider,
    client: await createClient(apiKey, provider),
  };
}

async function getCurrentSession(): Promise<CurrentSessionProvider> {
  if (currentSessionProvider) return currentSessionProvider;

  const envSession = await getSessionFromEnv();
  if (envSession) return envSession;

  const data = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
  const parsedData = JSON.parse(data) as AllSessionDetailsType;
  if (!parsedData) {
    throw Error('no Session is present');
  }

  let currentProvider: PROVIDERS_TYPES | null = null;

  (Object.keys(parsedData) as PROVIDERS_TYPES[]).forEach((provider) => {
    if (parsedData[provider]?.active === true) {
      currentProvider = provider;
    }
  });

  if (!currentProvider) {
    throw Error('No active provider, please set a provider');
  }
  if (!parsedData[currentProvider]) {
    throw Error('This provider is not exists');
  }
  const { apiKey, model } = parsedData[currentProvider];

  if (!apiKey) {
    throw Error('No API key available');
  }

  const client = await createClient(apiKey, currentProvider!);

  return {
    apiKey,
    model,
    provider: currentProvider!,
    client,
  };
}

export {
  PROVIDERS_MODELS,
  type PROVIDERS_TYPES,
  getCurrentSession,
  getAllSessions,
  maskSecret,
  updateProviderModel,
  upsertProviderInSession,
  writeAllSessionDetailsToFile,
};
