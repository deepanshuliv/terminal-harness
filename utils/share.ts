import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS_MODELS } from './modelsAndProviders';
import { createOpenRouterClient } from './openrouter';

const SESISON_FILE_PATH = `${process.cwd()}/database.json`;

type PROVIDERS_TYPES = keyof typeof PROVIDERS_MODELS;
type MODELS_SUPPORTED_TYPE =
  (typeof PROVIDERS_MODELS)[keyof typeof PROVIDERS_MODELS][number];

type AllSessiondetailsType = Partial<Record<PROVIDERS_TYPES, PesistedSession>>;

let allSessiondetails: AllSessiondetailsType = {};

interface PesistedSession {
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
    const data = await fs.readFile(SESISON_FILE_PATH, 'utf-8');
    const parsedData = JSON.parse(data) as AllSessiondetailsType;
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
        throw Error('Appropriate provider is not availabel');
      }
    }

    await writeAllSessionDeatilInFile(parsedData);
  } catch (error) {
    if (options.apiKey) {
      allSessiondetails[provider] = {
        active: true,
        apiKey: options.apiKey,
        model: model,
      };
      await writeAllSessionDeatilInFile(allSessiondetails);
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

async function writeAllSessionDeatilInFile(session: AllSessiondetailsType) {
  const content = JSON.stringify(session);
  try {
    await fs.writeFile(SESISON_FILE_PATH, content);
  } catch (error) {
    throw Error('Failed to create session');
  }
}

async function updateProviderModel(
  provider: PROVIDERS_TYPES,
  model: MODELS_SUPPORTED_TYPE,
) {
  const data = await fs.readFile(SESISON_FILE_PATH, 'utf-8');
  const parsedData = JSON.parse(data) as AllSessiondetailsType;

  parsedData[provider]!.model = model;

  writeAllSessionDeatilInFile(parsedData);
}

async function getAllSessions(): Promise<AllSessiondetailsType> {
  const data = await fs.readFile(SESISON_FILE_PATH, 'utf-8');
  const currentSessionProviders = JSON.parse(data) as AllSessiondetailsType;

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

  const data = await fs.readFile(SESISON_FILE_PATH, 'utf-8');
  const parsedData = JSON.parse(data) as AllSessiondetailsType;
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
    throw Error('No actiive provider  please set a provider');
  }
  if (!parsedData[currentProvider]) {
    throw Error('This provider is not exists');
  }
  const { apiKey, model } = parsedData[currentProvider];

  if (!apiKey) {
    throw Error('No api key availabel');
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
  updateProviderModel,
  upsertProviderInSession,
  writeAllSessionDeatilInFile,
};
