
import SwaggerParser from "@apidevtools/swagger-parser";
//@ts-ignore
import { loadConfig } from "@axway/amplify-cli-utils";
import yaml from "js-yaml";
import * as uri from "url";
import { Config, ConfigKeys, ProxySettings, getPageConfig, ReadOpts } from "../types";
import { commitToFs, getIconData, isOASExtension, requestPromise } from "./utils";

// TODO: fix tsconfig
module.exports = class Layer7Service {
  private proxySettings: ProxySettings = { strictSSL: true, proxy: undefined }
  private accessToken: string = ''
  private url: uri.URL = new uri.URL(this.config.baseUrl)
  constructor(private config: Config) {

    // validate if all the required configuration options have been set
    let missingParam = [
      ConfigKeys.ENVIRONMENT_NAME,
      ConfigKeys.CLIENT_ID,
      ConfigKeys.CLIENT_SECRET,
      ConfigKeys.BASE_URL,
      ConfigKeys.WEBHOOK_URL
    ].reduce((acc: Array<string>, cur: string) => {
      if (!(config as any)[cur]) {
        acc.push(cur);
        return acc;
      }
      return acc;
    }, []);

    if (missingParam.length) {
      console.log(`Missing required config: [${missingParam.join(', ')}]. Run 'amplify central layer7-extension config set -h' to see a list of params`);
      return process.exit(1);
    }

    // read amplify-cli config values for network settings
    const amplifyConfig = loadConfig().values;

    // Configure a proxy if it is configured
    const { strictSSL, httpProxy: proxy } = amplifyConfig.network || {};

    if (strictSSL === false) {
			this.proxySettings.strictSSL = false;
		}

		if (proxy) {
			try {
				const parsedProxy = new uri.URL(proxy);
				this.proxySettings.proxy = proxy;
				console.log(`Connecting using proxy settings protocol:${parsedProxy.protocol}, host:${parsedProxy.hostname}, port: ${parsedProxy.port}, username: ${parsedProxy.username}, rejectUnauthorized: ${this.proxySettings.strictSSL}`);
			} catch (e) {
				console.log(`Could not parse proxy url ${proxy}`);
				return process.exit(1);
			}
    }
  }

  private async login() {
    const { clientId, clientSecret } = this.config;
    let login;

    try {
      login = await requestPromise({
        method: 'POST',
        url: `${this.url.origin}/auth/oauth/v2/token`,
        body: `client_id=${clientId}&grant_type=client_credentials&scope=OOB&client_secret=${clientSecret}`,
        json: true,
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        ...this.proxySettings
      }) as any || { access_token: undefined }
    } catch (error) {
      throw error
    }
    this.accessToken = login.access_token
  }

  public async generateResources() {
    let canPage = true; 
    let size = 100;
    let page = 0;

    console.log('Logging in...');
    await this.login();
    console.log('Generating resources files...');

    while (canPage === true) {
      const result = await this.getPage({
        page,
        size
      }) || { apis: [], canPage: false };

      // Process our REST/WSDL APIs
      result.apis.length && await Promise.all(result.apis.map(async (entry: any) => {
        const { __definition: definition, ...meta } = entry;
        const { __assetType: assetType } = meta;
        if (entry.apiServiceType === 'REST' && assetType !== 'WADL') {
          let api;
          try {
            api = await SwaggerParser.validate(definition);
          } catch (error) {
            if ((error?.message || '').includes('Unsupported OpenAPI version')) {
              api = definition;
            } else {
              console.warn('skipping', error);
            }
          }
          api && await this.writeAPI4Central(meta, api)
        } else if (entry.apiServiceType === 'SOAP') {
          await this.writeAPI4Central(meta, definition)
        } else if (entry.apiServiceType === 'REST' && assetType === 'WADL') {
          await this.writeAPI4Central(meta, definition)
        }
      }));

      // Setup for next loop or to exit
      page++;
      canPage = result.canPage;
    }
  }

  private async read(readOpts: ReadOpts): Promise<any> {
    // fetchs apis
    const { size = 100, page = 1, path = '/', opts = {} } = readOpts;
    const qs = `?size=${size}&page=${page}`;
    let url = `${this.url.href}${path.startsWith('/') ? path : '/' + path}${qs}`;

    return { data: await requestPromise({
      method: 'GET',
      json: true,
      url,
      auth: {
        bearer: this.accessToken
      },
      ...opts,
      ...this.proxySettings
    })}
  }

  /**
   * Reads the layer7 apis, returns { apis: object, canPage: bool }
   * @param pageOptions object containing page info
   */
  private async getPage(pageOptions: getPageConfig) {    
    const { page, size } = pageOptions;

    try {
      // List all APIs
      const { data }  = await this.read({
        page,
        size,
        path: '/api-management/1.0/apis'
      });

      let apis = (await Promise.all(data.results.map(async (item: any) => {
        
        // get api metadata
        let { data: api }  = await this.read({
          path: `/api-management/1.0/apis/${item.uuid}`
        })

        // get assets for api
        let { data: assets } = await this.read({
          path: `/api-management/1.0/apis/${item.uuid}/assets`
        }) || [];

        // TODO: Is this the best/only way to get spec? Only expect one?
        assets = assets.filter((asset: any) => {
          // Use this to handle wadle vs wsdl
          api.__assetType = asset.type;
          return (asset.type === 'JSON' && isOASExtension(asset.name)) || ['WSDL', 'WADL'].includes(asset.type)
        });
        if (assets.length > 1) {
          // Do we have confidense there is only one
          throw new Error('More than one spec file found');
        }

        // Fetch the spec file
        if (assets.length) {
          api.__fileName = assets[0].name;

          const { data: definition } =  await this.read({
            path: `/api-management/1.0/apis/${item.uuid}/assets/${assets[0].uuid}/file`,
            opts: {
              json: false,
              headers: {
                accept: 'application/json, application/xml'
              }
            }
          })
          api.__definition = definition
        }

        return api;
 
      }))).filter((a: any) => {
        if (a.apiServiceType === 'REST' && a.__assetType !== 'WADL') {
          // Parse the yaml/json while we're at it
          const isOAS = this.peek(a.__fileName, a.__definition)
          if (!!isOAS && typeof isOAS === 'object') {
            a.__definition = isOAS
          }
          return !!isOAS;
        } else if (a.apiServiceType === 'SOAP') {
          return true;
        } else if (a.apiServiceType === 'REST' && a.__assetType === 'WADL') {
          return true
        }
        return false;
      })

      // return our apis and indicate if we can still page
      return { apis, canPage: !(data.currentPage + 1 >= data.totalPages) };
     } catch (e) {
       throw (e);
     }
  }

  /**
   * Parses a file and peeks in to check if it is a swagger / openapi specification
   * If its a yaml then might as well return truthy with the spec
   * @param name file name
   * @param contents contents of the file
   */
  private peek(name: string, contents: string) {
    let isOAS = false;
    if (/\.(yaml|yml)$/i.test(name)) {
      // see if root of YAML is swagger for v2.0 or openapi for v3.0s
      const obj: any = yaml.safeLoad(contents);
      if (obj.swagger || obj?.openapi) {
        isOAS = obj;
      }
    } else if (/\.(json)$/i.test(name)) {
      // see if root of JSON is XXX
      const obj = JSON.parse(contents);
      if (obj.swagger || obj.openapi) {
        isOAS = obj;
      }
    }
    return isOAS;
  }

  private async writeAPI4Central(meta: any, api: any) {
    const resources = [];
    const iconData = getIconData(this.config.icon);

    const {
      uuid: apiId,
      name,
      portalStatus,
      description,
      privateDescription,
      version,
      ssgUrl,
      authenticationParameters,
      authenticationType,
      __assetType: assetType,
      __fileName: fileName
    } = meta;
    const attributes = { apiId };
    const apiServiceName = `${name}`.toLowerCase().replace(/\W+/g, "-");
    

    // APIService
    const apiService = {
      apiVersion: "v1alpha1",
      kind: "APIService",
      name: apiServiceName,
      title: api?.info?.title || apiServiceName,
      attributes: attributes,
      metadata: {
        scope: {
          kind: "Environment",
          name: this.config.environmentName,
        },
      },
      spec: {
        description: privateDescription,
        icon: iconData,
      },
    };

    resources.push(apiService);

    // APIServiceRevision
    const apiServiceRevisionName = `${apiServiceName}-${version}`;

    let type = "oas3";
    if (api.swagger) {
      type = "oas2";
    } else if (assetType === 'WSDL') {
      type = 'wsdl'
    } else if (assetType === 'WADL') {
      type = 'wadl'
    }
    
    const apiServiceRevision = {
      apiVersion: "v1alpha1",
      kind: "APIServiceRevision",
      name: apiServiceRevisionName,
      title: apiServiceRevisionName,
      attributes: attributes,
      metadata: {
        scope: {
          kind: "Environment",
          name: this.config.environmentName,
        },
      },
      spec: {
        apiService: apiServiceName,
        definition: {
          type: type,
          value: Buffer.from(typeof api === 'string' ? api : JSON.stringify(api)).toString("base64"),
        },
      },
    };

    resources.push(apiServiceRevision);

    const endpoints = [];

    if (type === "oas2" || type === 'wsdl') {
      const parsedUrl = new uri.URL(this.config.baseUrl);
      endpoints.push({
        host: parsedUrl.hostname,
        protocol: parsedUrl.protocol.replace(':',''),
        ...(parsedUrl.port ? { port: parseInt(parsedUrl.port, 10) } : {}),
        ...(ssgUrl ? { routing: { basePath: ssgUrl.startsWith('/') ? ssgUrl : `/${ssgUrl}` } } : {}),
      });
    } else if (type === 'oas3') {
      for (const _ of api.servers) {
        const parsedUrl = new uri.URL(this.config.baseUrl);
        endpoints.push({
          host: parsedUrl.hostname,
          protocol: parsedUrl.protocol.replace(':', ''),
          routing: { basePath: ssgUrl.startsWith('/') ? ssgUrl : `/${ssgUrl}` },
          ...(parsedUrl.port ? { port: parseInt(parsedUrl.port, 10) } : {})
        });
      }
    }

    // APIServiceInstance
    const apiServiceInstance = {
      apiVersion: "v1alpha1",
      kind: "APIServiceInstance",
      name: apiServiceName,
      attributes: attributes,
      metadata: {
        scope: {
          kind: "Environment",
          name: this.config.environmentName,
        },
      },
      spec: {
        apiServiceRevision: apiServiceRevisionName,
        endpoint: endpoints,
      },
    };

    resources.push(apiServiceInstance);

    // ConsumerInstance
    const consumerInstance = {
      apiVersion: "v1alpha1",
      kind: "ConsumerInstance",
      name: apiServiceName,
      attributes: {
        ...attributes,
        authenticationType
      },
      metadata: {
        scope: {
          kind: "Environment",
          name: this.config.environmentName,
        },
      },
      spec: {
        state: "PUBLISHED",
        name: apiServiceName,
        apiServiceInstance: apiServiceName,
        subscription: {
          enabled: portalStatus === 'ENABLED' && authenticationType !== 'NONE',
          autoSubscribe: false,
          subscriptionDefinition: 'consumersubdef'
        },
        ...(!!description ? { description } : { description: '' }),
        ...(!!authenticationParameters ? {
          documentation: `Authentication parameters: ${authenticationParameters}`
        } : { documentation: '' }),
        version,
        ...(assetType === 'WADL' ? {
            unstructuredDataProperties: {
              contentType: 'application/xml',
              fileName,
              label: 'WADL'
        }
        }: {})
      },
    };

    resources.push(consumerInstance);
    await commitToFs(consumerInstance, this.config.outputDir, resources);
  }
}
