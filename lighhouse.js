/* eslint-disable import/no-extraneous-dependencies, import/no-dynamic-require */
const lighthouse = require('lighthouse');
const { defaultSettings } = require('lighthouse/lighthouse-core/config/constants');
const chromeLauncher = require('chrome-launcher');
const puppetteer = require('puppeteer');
const { green, yellow, white } = require('chalk');
const lighthouseLogger = require('lighthouse-logger');
const { log, error, executeWithMessage } = require('./utils');
const {
  getReportFolder,
  getReportPath,
  generateReportForHash,
  generateDigests
} = require('./lighthouse-utils');

// trigger Chrome as headfull or headelesss
const useHeadless = typeof process.argv.find(arg => arg === '--headfull') === 'undefined';

// flag to use when running locally simply to get status out of your localhost
const isLocalRun = typeof process.argv.find(arg => arg === '--local') !== 'undefined';

// URL used to fire lighthouse against
const baseURL = process.argv.find(arg => arg.indexOf('url=') !== -1)
  ? process.argv.find(arg => arg.indexOf('url=') !== -1).split('=')[1]
  : '';

// Signals to save report file to master
const updateMaster = typeof process.argv.find(arg => arg === '--update-master') !== 'undefined';

// Flag to indicate which branch/hash is going to be used as benchmark. Defaults to origin/master
const benchmark = process.argv.find(arg => arg.indexOf('benchmark') !== -1)
  ? process.argv.find(arg => arg.indexOf('benchmark') !== -1).split('=')[1] || 'origin/master'
  : false;

const baseDir = __dirname;

const packageJson = require(`${baseDir}/package.json`);
const PACKAGE_VERSION = packageJson.version;

const reportFormat = useHeadless ? 'json' : 'html';

const perfRun = {
  extends: 'lighthouse:default',
  settings: Object.assign({}, defaultSettings, {
    disableDeviceEmulation: true
  }),
  audits: [
    'user-timings',
    'critical-request-chains',
    'byte-efficiency/unused-javascript'
  ],
  passes: [
    {
      passName: 'extraPass',
      gatherers: [
        'js-usage'
      ]
    }
  ],
  categories: {
    performance: {
      name: 'Performance Metrics',
      description: "These encapsulate your web app's performance.",
      auditRefs: [
        { id: 'unused-javascript', weight: 0, group: 'load-opportunities' }
      ]
    }
  }
};

function launchChromeAndRunLighthouse(url, opts, config = perfRun) {
  return chromeLauncher.launch({ chromeFlags: opts.chromeFlags, chromePath: puppetteer.executablePath() }).then((chrome) => {
    opts.port = chrome.port;

    return lighthouse(url, opts, config).then((results) => {
      // use results.lhr for the JS-consumeable output
      // https://github.com/GoogleChrome/lighthouse/blob/master/typings/lhr.d.ts
      // use results.report for the HTML/JSON/CSV output as a string
      // use results.artifacts for the trace/screenshots/other specific case you need (rarer)
      if (benchmark) {
        return executeWithMessage(undefined, 'git rev-list origin/master..HEAD')()
          .then(({ stdout: revlist }) => (revlist.replace('\n', '') === '' ? 'master' : revlist.split('\n')[0]))
          .then((currentBranch) => {
            if (!isLocalRun && benchmark === 'origin/master' && currentBranch === 'master') {
              log('running on master, benchmarking is skipped', yellow);
              return generateReportForHash(chrome, results, reportFormat)({ stdout: currentBranch });
            }

            return executeWithMessage(undefined, `git rev-parse --verify ${benchmark}`)()
              .then(({ stdout: prevHash }) => {
                const folderName = benchmark === 'origin/master' ? 'master' : prevHash.replace('\n', '');
                const prevDirName = getReportFolder(folderName);
                const reportFile = getReportPath(prevDirName, reportFormat);
                const regressionDigest = {};
                const improvementDigest = {};

                try {

                  // This is just an example of how to identify regressions.
                  // You would want to set a threashold to when the diff would become significant to flag
                  const prevReport = require(reportFile);

                  const { lhr: report } = results;

                  if (report.audits.interactive.score < prevReport.audits.interactive.score) {
                    const regressionMessage = 'TTI is longer than benchmark';
                    regressionDigest.interactive = {
                      regression: `${Math.floor((report.audits.interactive.rawValue - prevReport.audits.interactive.rawValue) / 10)}ms`,
                      regressionMessage
                    };

                    error(`WARN: ${regressionMessage}`);
                  } else if (report.audits.interactive.score > prevReport.audits.interactive.score) {
                    const message = 'TTI has improved from last version';
                    improvementDigest.interactive = {
                      improvement: `${Math.floor((report.audits.interactive.rawValue - prevReport.audits.interactive.rawValue) / 10)}ms`,
                      message
                    };

                    log(`INFO: ${message}`, green);
                  }

                  if (report.audits['mainthread-work-breakdown'].score < prevReport.audits['mainthread-work-breakdown'].score) {
                    const regressionMessage = 'This hash is hogging more on the main thread than benchmark';
                    regressionDigest['mainthread-work-breakdown'] = {
                      regression: `${Math.floor((report.audits['mainthread-work-breakdown'].rawValue - prevReport.audits['mainthread-work-breakdown'].rawValue) / 10)}ms`,
                      regressionMessage
                    };

                    error(`WARN: ${regressionMessage}`);
                  } else if (report.audits['mainthread-work-breakdown'].score > prevReport.audits['mainthread-work-breakdown'].score) {
                    const message = 'This hash has freed CPU workload compared to last release';
                    improvementDigest['mainthread-work-breakdown'] = {
                      improvement: `${Math.floor((report.audits['mainthread-work-breakdown'].rawValue - prevReport.audits['mainthread-work-breakdown'].rawValue) / 10)}ms`,
                      message
                    };

                    log(`INFO: ${message}`, green);
                  }

                  // whatever other metrics matter to you

                  try {
                    const regressions = {};

                    Object.keys(report.audits.metrics.details.items[0]).forEach((metric) => {
                      const oldMetric = prevReport.audits.metrics.details.items[0][metric];
                      const currentMetric = report.audits.metrics.details.items[0][metric];

                      if (oldMetric < currentMetric) {
                        regressions[metric] = currentMetric - oldMetric;
                      }
                    });

                    if (Object.keys(regressions).length !== 0) {
                      const regressionMessage = 'This hash has the follow regressions on raw metrics';

                      error(`WARN: ${regressionMessage}`);
                      log(JSON.stringify(regressions, null, 2), yellow.dim);
                    }
                  } catch (err) {
                    error('Could not parse and compare raw metrics');
                    log(err, white.dim);
                  }
                } catch (err) {
                  error(err);
                }

                const reportFolder = getReportFolder(currentBranch);

                return executeWithMessage(undefined, `yarn rimraf ${reportFolder} && mkdir ${reportFolder}`)()
                  .then(
                    () => generateDigests({ regressions: regressionDigest, improvements: improvementDigest }, currentBranch)
                      .then(() => (
                        generateReportForHash(chrome, results, reportFormat)({ stdout: currentBranch })
                      ))
                  );
              });
          });
      }

      return executeWithMessage(undefined, 'git rev-list origin/master..HEAD')()
        .then(({ stdout: revlist }) => ({ stdout: revlist.replace('\n', '') === '' ? 'master' : revlist.split('\n')[0] }))
        .then(generateReportForHash(chrome, results, reportFormat));
    });
  });
}

const opts = {
  chromeFlags: useHeadless ? [
    '--show-paint-rects',
    '--headless',
    '--ignore-certificate-errors'
  ] : ['--show-paint-rects', '--ignore-certificate-errors'],
  extraHeaders: { 'shipping-module-version': PACKAGE_VERSION },
  logLevel: 'info',
  output: [
    'json',
    'html'
  ]
};
lighthouseLogger.setLevel(opts.logLevel);

executeWithMessage('Starting lighthouse report', 'git rev-list origin/master..HEAD')()
  .then(({ stdout: revlist }) => (revlist.replace('\n', '') === '' ? 'master' : revlist.split('\n')[0]))
  .then((hash) => {
    const { config } = require('./utils');

    if (!isLocalRun && hash === 'master' && !updateMaster) {
      log('Skipping lighthouse report on master merge');
      return true;
    }

    const lighthousePromise = launchChromeAndRunLighthouse(
      // This taks assumes that we are publishing the reults into a separate repository.
      // Reason for that is to have better history without polluting the main repo.
      // The lightouse-base-app is the directory where I'd have the create-react-app instance to run with the bundled code from the PR
      baseURL === ''
        ? `${config.BITBUCKET_URL}/pages/${config.TEAM_PROJECT_NAME}/${config.LIGHTHOUSE_APP_REPO_NAME}/${hash.replace('\n', '')}/browse/lightouse-base-app/build/index.html`
        : baseURL,
      opts
    )
      .then(result => (
        useHeadless
          ? log(`Report saved to ${result}`, green)
          : chromeLauncher.launch({ startingUrl: `file:///${result}` })
      ));

    return isLocalRun
      ? lighthousePromise
      : lighthousePromise
        .then(() => {
          if (hash !== 'master') {
            return executeWithMessage('Switching to lighthouse-branch branch', `git fetch --all && git checkout -B lighthouse-base lighthouse-base/${hash}`)()
              .then(executeWithMessage('Sending report to lighthouse-base-app remote', `git add reports/* && git commit -m "Report files for ${hash}" && git push lighthouse-base HEAD:${hash}`))
              .then(executeWithMessage(undefined, 'git checkout -'));
          }

          return true;
        })
        .then(() => {
          if (updateMaster) {
            return executeWithMessage('Updating master report file', 'git add . && git commit -m "RELEASE: Update lighthouse report 🤖" && git push origin HEAD:master')();
          }

          log('Not on master, skipping commit of report');
          return true;
        });
  })
  .then(() => process.exit())
  .catch((err) => {
    error(err);
    process.exit(1);
  });
