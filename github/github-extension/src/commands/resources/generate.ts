//@ts-ignore
import { snooplogg } from "cli-kit";
import { readJsonSync } from "fs-extra";
import { Config } from "../../../types";
import { configFilePath, createSupportResources } from "../../utils";
const GithubService = require('../../service.js');
const chalk = require('chalk');

type args = {
  console: Console;
};

const { log } = snooplogg("github-extension: resources: generate");

export const generate = {
  action: async ({ console }: args) => {
    log("Generating resources");
    const config: Config = readJsonSync(configFilePath);
    config.outputDir = typeof config.outputDir === 'string' ? config.outputDir : './resources';
    const githubService = new GithubService(config);
    await createSupportResources(config);
    await githubService.generateResources();
    console.log(chalk['yellow'](`Resources created in ${config.outputDir}`));
    console.log(chalk['yellow']("Upload example: 'axway central create -f=<path to resource>'\n"));
  },
};
