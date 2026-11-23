// Everything the Dashboard Screen Viewer gateway needs, in one resource group.
// Deploy with scripts/deploy-gateway.sh, which validates the token lists and passes them in.

@description('Region for all resources.')
param location string = resourceGroup().location

@description('Globally unique storage account name: 3-24 lowercase letters and digits.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Private Blob container holding the screenshots.')
param containerName string = 'screenshots'

@description('Container App name; the environment and identity are named after it.')
param gatewayName string = 'dashboard-gateway'

@description('Gateway container image, pullable without credentials (for example a public GHCR image).')
param gatewayImage string

@secure()
@description('JSON object mapping display token IDs to SHA-256 hashes of their tokens.')
param deviceTokenHashes string

@secure()
@description('JSON object mapping publisher token IDs to SHA-256 hashes of their tokens.')
param publisherTokenHashes string = ''

@description('Fingerprint of the token lists. Changing it starts a new revision so revocations take effect; secret updates alone don\'t restart running replicas.')
param tokenListsVersion string

@description('Set false when the identity already has Storage Blob Data Contributor on the container under another assignment name (Azure rejects duplicates).')
param assignBlobRole bool = true

// Storage Blob Data Contributor
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    // Entra ID only: no account keys or SAS. Only the gateway's identity is granted access.
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: { publicAccess: 'None' }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${gatewayName}-identity'
  location: location
}

resource blobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignBlobRole) {
  scope: container
  name: guid(container.id, identity.id, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${gatewayName}-env'
  location: location
  properties: {
    // No log destination: request logs aren't collected or billed.
    appLogsConfiguration: {}
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    zoneRedundant: false
  }
}

resource gateway 'Microsoft.App/containerApps@2024-03-01' = {
  name: gatewayName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        { name: 'device-hashes', value: deviceTokenHashes }
        { name: 'publisher-hashes', value: empty(publisherTokenHashes) ? '{}' : publisherTokenHashes }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        traffic: [ { latestRevision: true, weight: 100 } ]
      }
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: gatewayImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'STORAGE_CONTAINER_URL', value: '${storage.properties.primaryEndpoints.blob}${containerName}' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'GATEWAY_DEVICE_TOKENS', secretRef: 'device-hashes' }
            { name: 'GATEWAY_PUBLISHER_TOKENS', secretRef: 'publisher-hashes' }
            { name: 'TOKEN_LISTS_VERSION', value: tokenListsVersion }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [ { name: 'http', http: { metadata: { concurrentRequests: '4' } } } ]
      }
    }
  }
  dependsOn: [ blobAccess ]
}

output gatewayUrl string = 'https://${gateway.properties.configuration.ingress.fqdn}'
output storageAccount string = storage.name
output identityClientId string = identity.properties.clientId
