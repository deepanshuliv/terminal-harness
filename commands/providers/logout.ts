import { Command } from 'commander';
import {
  getAllSessions,
  PROVIDERS_TYPES,
  writeAllSessionDetailsToFile,
} from '../../utils/share';

export const logoutCommand = new Command('logout')
  .description('Lets user logout from the provider')
  .option(
    '-p, --provider <providerName>',
    'Name of the provider (gemini, claude etc)',
    '',
  )
  .action(async (options) => {
    const data = await getAllSessions();
    if (!data) {
      console.error('No session TO logout');
      process.exit(1);
    }

    const providerToDelete = (Object.keys(data) as PROVIDERS_TYPES[]).find(
      (provider) => {
        return provider === options.provider;
      },
    );
    if (!providerToDelete) {
      console.error('No session TO logout');
      process.exit(1);
    }

    delete data[providerToDelete];
    await writeAllSessionDetailsToFile(data);
    console.log('Session logout successfully');
  });
