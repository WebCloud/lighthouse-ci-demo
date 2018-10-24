const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {
  cyan,
  red,
  white
} = require('chalk');

const log = (message, color = cyan) => console.log('\n', color(message));
const error = message => console.error('\n', red(message));

const executeWithMessage = (message, command) => async () => {
  if (message && message !== '') log(message);

  const { stdout, stderr } = await exec(command);
  log(stdout, white.dim);
  log(stderr, white.dim);

  return { stdout, stderr };
};

function requireFromString(src, filename) {
  const Module = module.constructor;
  const m = new Module();
  m._compile(src, filename);
  return m.exports;
}

const config = {
  BITBUCKET_URL: 'https://bitbucket.url',
  TEAM_PROJECT_NAME: 'team_proj_name',
  LIGHTHOUSE_APP_REPO_NAME: 'metrics_proj_url'
}

module.exports = {
  log,
  error,
  executeWithMessage,
  requireFromString,
  config
};
