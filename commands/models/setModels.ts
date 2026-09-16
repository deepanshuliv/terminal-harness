import { Command } from 'commander';
import {
  getCurrentSession,
  PROVIDERS_MODELS,
  updateProviderModel,
} from '../../utils/share';

export const setModel = new Command('set')
  .option('-m , --model <model_name>', 'select model in current session', '')
  .action(async (options) => {
    try {
      const session = await getCurrentSession();

      const model = PROVIDERS_MODELS[session.provider].find(
        (model) => model === options.model,
      );
      if (!model) {
        console.error(
          `Model ${options.model} is not Found on ${session.provider}`,
        );
        process.exit(1);
      }
      await updateProviderModel(session.provider, model);
      console.log(
        `Model ${options.model} set successfully on provider ${session.provider}`,
      );
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
