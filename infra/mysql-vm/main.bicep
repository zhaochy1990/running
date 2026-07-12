targetScope = 'resourceGroup'

@description('Azure region for the MySQL VM resources.')
param location string = resourceGroup().location

@description('Resource name prefix. Keep this stable after the first deployment.')
param namePrefix string = 'stride-mysql'

@description('Linux VM size for the MySQL host.')
param vmSize string = 'Standard_D2as_v7'

@description('Admin username for Azure VM access. Password login is disabled.')
param adminUsername string = 'azureuser'

@secure()
@description('SSH public key for the VM admin user. The VM has no public IP by default; use Run Command or private network access.')
param adminSshPublicKey string

@description('Virtual network CIDR for the private MySQL network.')
param vnetAddressPrefix string = '10.90.0.0/16'

@description('Subnet CIDR for the MySQL VM.')
param subnetAddressPrefix string = '10.90.1.0/24'

@description('Initial MySQL database created by cloud-init.')
param mysqlDatabaseName string = 'stride'

@description('Initial MySQL application user created by cloud-init.')
param mysqlAppUser string = 'stride_app'

@description('MySQL host pattern allowed for the application user. Keep this private to the VNet address space.')
param mysqlAllowedHost string = '10.90.%'

@minValue(32)
@description('Managed data disk size in GiB. The disk is mounted at /var/lib/mysql.')
param dataDiskSizeGb int = 128

@allowed([
  'Premium_LRS'
  'Premium_ZRS'
  'StandardSSD_LRS'
  'StandardSSD_ZRS'
])
@description('Managed data disk SKU.')
param dataDiskSku string = 'Premium_LRS'

@description('Ubuntu image SKU for the VM. In southeastasia, Canonical ubuntu-24_04-lts uses sku=server for the standard server image.')
param ubuntuImageSku string = 'server'

var vnetName = '${namePrefix}-vnet'
var subnetName = '${namePrefix}-subnet'
var nsgName = '${namePrefix}-nsg'
var nicName = '${namePrefix}-nic'
var vmName = '${namePrefix}-vm'
var osDiskName = '${namePrefix}-osdisk'
var dataDiskName = '${namePrefix}-data'
var publicIpName = '${namePrefix}-egress-pip'
var natGatewayName = '${namePrefix}-nat'

var mysqlSetup = replace(replace(replace(replace(loadTextContent('mysql-setup.sh'), '__MYSQL_DATABASE_B64__', base64(mysqlDatabaseName)), '__MYSQL_APP_USER_B64__', base64(mysqlAppUser)), '__MYSQL_ALLOWED_HOST_B64__', base64(mysqlAllowedHost)), '__MYSQL_ALLOWED_CIDR_B64__', base64(vnetAddressPrefix))
var cloudInit = replace(loadTextContent('cloud-init.yaml'), '__MYSQL_SETUP_SCRIPT_B64__', base64(mysqlSetup))

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowMySQLFromVirtualNetwork'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '3306'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowSshFromVirtualNetwork'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'DenyOtherInboundFromVirtualNetwork'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource egressPublicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: publicIpName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = {
  name: natGatewayName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [
      {
        id: egressPublicIp.id
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: subnetAddressPrefix
    networkSecurityGroup: {
      id: nsg.id
    }
    natGateway: {
      id: natGateway.id
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnet.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: ubuntuImageSku
        version: 'latest'
      }
      osDisk: {
        name: osDiskName
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
      dataDisks: [
        {
          lun: 0
          name: dataDiskName
          createOption: 'Empty'
          diskSizeGB: dataDiskSizeGb
          managedDisk: {
            storageAccountType: dataDiskSku
          }
        }
      ]
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(cloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            primary: true
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

output vmName string = vm.name
output vnetName string = vnet.name
output subnetName string = subnetName
output outboundPublicIp string = egressPublicIp.properties.ipAddress
output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output mysqlEndpoint string = '${nic.properties.ipConfigurations[0].properties.privateIPAddress}:3306'
