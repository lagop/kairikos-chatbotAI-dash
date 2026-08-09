import { createStagingMagicLinkClient } from '/paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/portal/tests/helpers/staging-magic-link.ts';

const client = createStagingMagicLinkClient();
const users = ['onboarding-test1@kairikos.dev', 'onboarding-test2@kairikos.dev', 'staff-test@kairikos.dev'];

(async () => {
  for (const email of users) {
    const link = await client.generateMagicLink(email);
    console.log(email, '->', link);
  }
})();
