#!/usr/bin/env node

const readdir = require("node:fs/promises").readdir;
const fs = require("fs");
// const { argv } = require("node:process");
const join = require("node:path").join;
const toml = require("@iarna/toml");
const parseGitConfig = require("parse-git-config");
const axios = require("axios");
const chalk = require("chalk");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const argv = yargs(hideBin(process.argv))
  .version(false)
  .command(
    "deps [path]",
    "get dependency information from Cargo.toml",
    (yargs) => {
      return yargs
        .positional("path", {
          describe: "The path to the source",
          default: ".",
        })
        .option("lock", {
          describe: "verify Cargo.lock",
          group: "Dependency Options",
          alias: "l",
          type: "boolean",
          default: false,
        })
        .option("verbose", {
          describe: "print verbose",
          group: "Dependency Options",
          alias: "v",
          type: "boolean",
          default: false,
        });
    },
    (argv) =>
      cmdDependencies(argv.path, argv.lock, argv.verbose).catch(console.error)
  )
  .command(
    "commits <path> <previous-branch> <previous-branch-upstream>",
    "get dependency information from Cargo.toml",
    (yargs) => {
      return yargs
        .positional("path", {
          describe: "The path to the source",
          default: ".",
        })
        .positional("previous-branch", {
          describe: "The last stable branch",
          demandOption: true,
        })
        .positional("previous-branch-upstream", {
          describe: "The last stable branch in upstream",
          demandOption: true,
        });
    },
    (argv) =>
      cmdCommits(
        argv.path,
        argv.previousBranch,
        argv.previousBranchUpstream
      ).catch(console.error)
  )
  .demandCommand()
  .strict()
  .parse();

async function cmdCommits(path, branch, branchUpstream) {
  try {
    const gitConfig = parseGitConfig.sync({
      path: join(path, ".git", "config"),
    });
    console.log(gitConfig['remote "origin"']["url"]);
    const match = gitConfig['remote "origin"']["url"].match(
      /github.com:([^\/]+)\/([^.]+)(?:\.git)?/
    );
    const gitUrl = `https://github.com/${match[1]}/${match[2]}`;

    let result = await exec("git branch --show-current", { cwd: path });
    const currentBranch = result.stdout.trim();
    result = await exec(
      `git log -1 --pretty=format:'%h' remotes/upstream/${branchUpstream}`,
      { cwd: path }
    );
    const lastUpstreamCommit = result.stdout.trim();
    result = await exec(
      `git log --pretty=format:'%h %s' remotes/origin/${branch}`,
      { cwd: path }
    );
    const extraCommits = [];
    for (const commit of result.stdout.trim().split("\n")) {
      const parts = commit.split(" ");
      const sha = parts.shift();
      const subject = parts.join(" ");
      if (sha === lastUpstreamCommit) {
        break;
      }
      extraCommits.push({ sha, subject });
    }

    const needCommits = [];
    for (const extraCommit of extraCommits) {
      result = await exec(
        `git branch ${currentBranch} --contains ${extraCommit.sha}`,
        { cwd: path }
      );
      const hasCommit = result.stdout.trim().length > 0;
      if (!hasCommit) {
        needCommits.push(extraCommit);
      }
    }
    if (needCommits) {
      console.log(
        `Need the following commits on branch ${currentBranch}:\n${needCommits
          .map(
            ({ sha, subject }) =>
              `${chalk.yellow(sha)} ${chalk.gray(
                `${gitUrl}/commit/${sha}`
              )} ${subject} `
          )
          .join("\n")}`
      );
    }
  } catch (err) {
    console.log(err);
    throw new Error(`failed evaluating commits for ${path}: ${err}`);
  }
}

async function cmdDependencies(rootPath, cargoLock, verbose) {
  console.log(rootPath, cargoLock, verbose);
  const dependencies = {};

  // .git
  const gitConfig = parseGitConfig.sync({
    path: join(rootPath, ".git", "config"),
  });
  console.log(gitConfig['remote "origin"']["url"]);

  // Cargo.toml
  const files = await deepReadDir(
    rootPath,
    (path, dirent) => {
      if (dirent.isDirectory()) {
        return (
          (path == rootPath &&
            ["target", ".git", ".github"].includes(dirent.name)) ||
          ["node_modules"].includes(dirent.name)
        );
      }
      return false;
    },
    (_, dirent) => dirent.isFile() && dirent.name === "Cargo.toml"
  );

  for (const file of files) {
    try {
      const configToml = toml.parse(fs.readFileSync(file));
      const configDeps =
        configToml["dependencies"] ||
        (configToml["workspace"] && configToml["workspace"]["dependencies"]);
      if (!configDeps) {
        continue;
      }

      for (const dep of Object.keys(configDeps)) {
        if (configDeps[dep]["git"]) {
          const git = configDeps[dep]["git"];
          const branch = configDeps[dep]["branch"]
            ? configDeps[dep]["branch"]
            : "master";
          const key = `${git}#${branch}`;
          if (!dependencies[key]) {
            dependencies[key] = [];
          }
          dependencies[key].push(dep);
        }
      }
    } catch (err) {
      throw new Error(`failed decoding file ${file}: ${err}`);
    }
  }

  console.log("Cargo.toml");
  if (verbose) {
    console.log(JSON.stringify(dependencies, null, 2));
  } else {
    console.log(Object.keys(dependencies));
  }

  // Cargo.lock
  if (cargoLock) {
    const cargoLock = fs
      .readFileSync(join(rootPath, "Cargo.lock"))
      .toString("utf-8");
    const cargoLockPackage = { name: null, source: null };
    const cargoLockPackages = {};
    for (const cargoLine of cargoLock.split("\n")) {
      const line = cargoLine.trim();
      if (line === "[[package]]" && cargoLockPackage.name !== null) {
        if (!cargoLockPackages[cargoLockPackage.source]) {
          cargoLockPackages[cargoLockPackage.source] = [];
        }

        cargoLockPackages[cargoLockPackage.source].push(cargoLockPackage.name);
      }

      if (line.startsWith('name = "')) {
        cargoLockPackage.name = line.match(/name = "([^"]+)"/)[1];
      }
      if (line.startsWith('source = "')) {
        cargoLockPackage.source = line.match(/source = "([^"]+)"/)[1];
      }
    }

    console.log("Cargo.lock");
    if (verbose) {
      console.log(JSON.stringify(cargoLockPackages, null, 2));
    } else {
      console.log(Object.keys(cargoLockPackages));
    }

    // verify commits are latest
    for (const source of Object.keys(cargoLockPackages)) {
      const match = source.match(
        /git\+https:\/\/github.com\/([^/]+)\/([^/]+)(?:.git)?\?branch=([^#]+)#(\w+)/
      );
      if (match) {
        const gitInfo = await axios.get(
          `https://api.github.com/repos/${match[1]}/${match[2].replace(".git", "")}/commits/${match[3]}`
        );
        const sha = gitInfo.data.sha;
        if (sha !== match[4]) {
          console.log(
            `SHA error! The latest commit hash is ${sha} for repo ${match[1]}/${match[2]}, branch '${match[3]}', got ${match[4]}: \n\t${source}`
          );
        }
      }
    }
  }
}

async function deepReadDir(dirPath, ignoreFn, matcherFn) {
  return (
    await Promise.all(
      (
        await readdir(dirPath, { withFileTypes: true })
      ).map(async (dirent) => {
        const path = join(dirPath, dirent.name);
        if (ignoreFn(dirPath, dirent)) {
          return null;
        }

        if (dirent.isDirectory()) {
          return await deepReadDir(path, ignoreFn, matcherFn);
        }

        if (!matcherFn(dirPath, dirent)) {
          return null;
        }

        return path;
      })
    )
  )
    .flat(Number.POSITIVE_INFINITY)
    .filter((it) => it);
}
