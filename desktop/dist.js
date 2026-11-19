// Builds the Windows installer, signed when a code-signing certificate is available.
//   npm run dist
// Signing (either one; without them the installer is built unsigned and Windows SmartScreen warns):
//   A certificate file (.pfx, OV or EV from a certificate authority):
//     CSC_LINK=path\to\cert.pfx   CSC_KEY_PASSWORD=...
//   Azure Trusted Signing (Microsoft's signing service, the cheapest route for an individual or company):
//     AZURE_SIGN_ENDPOINT=https://eus.codesigning.azure.net   AZURE_SIGN_ACCOUNT=<account>   AZURE_SIGN_PROFILE=<certificate profile>
//     AZURE_SIGN_PUBLISHER=<the publisher name on the certificate>
//     plus the service principal: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
// The build also writes dist/latest.yml: copy it to the server's downloads folder with the installer, and the
// installed apps update themselves.
const { build, Platform } = require('electron-builder');
const pkg = require('./package.json');
const config = JSON.parse(JSON.stringify(pkg.build));
const E = process.env;
delete config.publish; // comes from package.json itself (passing it twice confuses the schema check)
if (E.AZURE_SIGN_ENDPOINT && E.AZURE_SIGN_ACCOUNT && E.AZURE_SIGN_PROFILE) {
  config.win.azureSignOptions = { endpoint: E.AZURE_SIGN_ENDPOINT, codeSigningAccountName: E.AZURE_SIGN_ACCOUNT, certificateProfileName: E.AZURE_SIGN_PROFILE, publisherName: E.AZURE_SIGN_PUBLISHER || pkg.author };
  console.log('Signing with Azure Trusted Signing:', E.AZURE_SIGN_ACCOUNT, '/', E.AZURE_SIGN_PROFILE);
} else if (E.CSC_LINK) {
  console.log('Signing with the certificate in CSC_LINK');
} else {
  console.log('No code-signing certificate set: building unsigned (see the top of dist.js to sign).');
}
build({ targets: Platform.WINDOWS.createTarget('nsis'), config, publish: 'never' })
  .then(out => console.log('Built:\n  ' + out.join('\n  ')))
  .catch(e => { console.error(e); process.exit(1); });
