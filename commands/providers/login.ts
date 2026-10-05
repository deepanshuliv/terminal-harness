import { Command } from 'commander';
import {
  PROVIDERS_MODELS,
  PROVIDERS_TYPES,
  maskSecret,
  upsertProviderInSession,
} from '../../utils/share';

export const loginCommand = new Command('login')
  .description('Lets user login into the provider (use it as default)')
  .option(
    '-p, --provider <providerName>',
    'Name of the provider (gemini, claude etc)',
    '',
  )
  .option('-a, --api_key <apiKey>', 'Your api key', '')
  .action(async (options) => {
    const providerAvailable =
      PROVIDERS_MODELS[options.provider as PROVIDERS_TYPES];
    if (!providerAvailable) {
      console.error(
        `"${options.provider}" provider is not supported currently`,
      );
    }

    if (providerAvailable && options.api_key) {
      try {
        await upsertProviderInSession(options.provider, {
          apiKey: options.api_key,
          active: true,
        });
      } catch (error) {
        console.error(error);
        process.exit(1);
      }

      console.log(
        `API key ${maskSecret(options.api_key)} saved for provider ${options.provider}`,
      );
    }
  });
