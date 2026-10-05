import { Command } from 'commander';
import {
  PROVIDERS_MODELS,
  PROVIDERS_TYPES,
  upsertProviderInSession,
} from '../../utils/share';

export const setProviderCommand = new Command('set')
  .description('Lets user set the default provider')
  .option(
    '-p, --provider <providerName>',
    'Name of the provider (gemini, claude etc)',
    '',
  )
  .action(async (options) => {
    // check for valid provider
    const availableProviders =
      PROVIDERS_MODELS[options.provider as PROVIDERS_TYPES];
    if (!availableProviders) {
      console.error(
        `"${options.provider}" provider is not supported currently`,
      );
    }
    // mark active as true and update in parsedData
    const active = true;
    try {
      await upsertProviderInSession(options.provider, { active });
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error(String(error));
      }
      process.exit(1);
    }
  });
