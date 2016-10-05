var _ = require('lodash');
var base64URL = require('base64url');

var config;
var log;
var loader;
var httpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

module.exports = {
    init : init
};

function init(app, config, logger, serviceLoader, swagger) {
    config = config.get('authentication');
    log = logger;
    loader = serviceLoader;
    _.forEach(swagger.getSimpleSpecs(), function (api, name) {
        var basePath = api.basePath || '';
        /* apply security requirements to each route path*/
        _.keys(api.paths).forEach(function (path) {
            var pathObj = api.paths[path];
            var routePath = basePath + _convertPathToExpress(path);

            //loop for http method keys, like get an post
            _.keys(pathObj).forEach(function (method) {
                if (_.contains(httpMethods, method)) {
                    var operation = pathObj[method];
                    if (operation['security']) {
                        _.keys(operation['security']).forEach(function (securityReq) {
                            _applySecurityRequirement(app, method, routePath, securityReq,
                                api.securityDefinitions[securityReq], operation['x-bos-permissions'][securityReq],
                                operation['security'][securityReq]);
                        });
                    }
                }
            });
        });
    });
}

function _applySecurityRequirement(app, method, route, securityReq, securityDefn, requiredPermissions, requiredScopes) {
    var scheme = securityDefn.type;
    switch (scheme) {
        case 'basic':
            app[method].call(app, route, basicExtractor());
            break;
        case 'apiKey':
            app[method].call(app, route, apiKeyExtractor(securityDefn)); //may also need a user provided 'verify' function here
            break;
        case 'oauth2':
            break;
        default:
            return log.warn('unrecognized security scheme %s for route %s', scheme, route);
    }
    /*//wire up path with user defined authentication method for this req
    if (config.authenticationMethods[securityReq]) {
        var parts = config.authenticationMethods[securityReq].split('.');
        var service = loader.get(parts[0]);
        if (!service) {
            return log.warn('Could not find service module named "%s".', parts[0]);
        }
        var serviceMethod = service[parts[1]];
        if (!_.isFunction(serviceMethod)) {
            return log.warn('Authentication function %s on module %s is missing or invalid.',
                parts[1], parts[0]);
        }
        //scopes included here for security type oauth2 where authentication/authorization happens in one go
        app[method].call(app, route, _.partialRight(serviceMethod, securityReq,
            securityDefn, requiredScopes));
        //wire up path with user defined authorization method
        if (config.authorizationMethods[securityReq]) {
            parts = config.authorizationMethods[securityReq].split('.');
            service = loader.get(parts[0]);
            if (!service) {
                return log.warn('Could not find service module named "%s".', parts[0]);
            }
            serviceMethod = service[parts[1]];
            if (!_.isFunction(serviceMethod)) {
                return log.warn('Authorization function %s on module %s is missing or invalid.',
                    parts[1], parts[0]);
            }
            var wrappedAuthorizationMethod = wrapAuthorizationMethod(serviceMethod, route,
                securityDefn, requiredPermissions);
            app[method].call(app, route, _.partialRight(wrappedAuthorizationMethod, route,
                securityDefn, requiredPermissions));
        } else {
            return log.warn('No authorization method found for security requirement %s', securityReq);
        }
    } else {
        return log.warn('No authentication method defined for security requirement %s', securityReq);
    }*/
}

function wrapAuthorizationMethod(authorizationMethod, route, securityDefn, requiredPermissions) {
    return function (req, res, next) {
        var runTimeRequiredPermissions = _expandRouteInstancePermissions(requiredPermissions, route, req.path);
        authorizationMethod.call(this, req, res, next, securityDefn, runTimeRequiredPermissions);
    };
}

function basicExtractor() {
    return function (req, res, next) {
        //header should be of the form "Basic " + user:password as a base64 encoded string
        var authHeader = req.getHeader('Authorization');
        var credentialsBase64 = authHeader.substring(authHeader.indexOf('Basic ') + 1);
        var credentials = base64URL.decode(credentialsBase64).split(':');
        req.user = {name: credentials[0], password: credentials[1], realm: 'Basic'};
        next();
    };
}

function apiKeyExtractor(securityDefn, verify) {
    return function (req, res, next) {
        if (!verifyMD5Header(req.body, req.getHeader('Content-MD5'))) {
            log.error('content md5 header for uri %s coming from %s did not match request body', req.path, req.ip);
            res.status(401).send('content md5 header did not match request body');
        }
        var apiId = 'where do we get this from?';
        var digest;
        if (securityDefn.in === 'query') {
            digest = req.query[securityDefn.name];
        } else if (securityDefn.in === 'header') {
            digest = req.getHeader(securityDefn.name);
        } else {
            return log.warn('unknown location %s for apiKey. ' +
                'looks like open api specs may have changed on us', securityDefn.in);
        }
        //this would have to be a user provided function that
        //fetches the user (and thus the private key that we need to compute the hash) from some data source
        //we don't need this if we decide that we will let the user figure out how to verify the digest
        verify(apiId, function (user) {
            //regenerate hash with apiKey
            //if (hash === digest)
            //  all good
            // else you suck
            req.user = user;
            next();
        });
    };
}

function verifyMD5Header(body, md5) {
    //calculate md5 of request body and verify that it equals the header
    return true;
}

function _expandRouteInstancePermissions(perms, route, uri) {
    /* relate the route path parameters to the url instance values
     perms: ["api:read:{policyid}", "api:read:{claimid}"]
     route: /api/v1/policies/:policyid/claims/:claimid
     [ api,v1,policies,:policyid,claims,:claimid ]
     uri:   /api/v1/policies/SFIH1234534/claims/37103
     [ api,v1,policies,SFIH1234534,claims,37103 ]
     */
    if (!_.isString(route) ||  !_.isString(uri)) {
        return perms;
    }
    var routeParts = route.split('/');
    var uriParts = uri.split('/');

    // [ [ ':policyid', 'SFIH1234534' ], [ ':claimid', '37103' ] ]
    var pathIds = _.zip(routeParts, uriParts)
        .filter(function (b) {
            return _.startsWith(b[0], ':');
        }).map(function (path) {
            // trim the :
            path[0] = path[0].substr(1);
            return path;
        });

    return _.map(perms, function (perm) {
        var ePerm = perm;
        _.forEach(pathIds, function (item) {
            ePerm = ePerm.replace('{' + item[0] + '}', item[1]);
        });
        return ePerm;
    });
}

//swagger paths use {blah} while express uses :blah
function _convertPathToExpress(swaggerPath) {
    var reg = /\{([^\}]+)\}/g;  //match all {...}
    swaggerPath = swaggerPath.replace(reg, ':$1');
    return swaggerPath;
}