import { Command } from 'commander';
import { PROVIDERS_MODELS } from '../../utils/share';

export const getModelsCommand = new Command('ls')
  .description('Returns all the supported models')
  .action(async () => {
    try {
      console.log('Listing models...');
      Object.entries(PROVIDERS_MODELS).forEach(([provider, modelArr]) => {
        console.log('->', provider);
        modelArr.forEach((model) => {
          console.log(model);
        });
      });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
