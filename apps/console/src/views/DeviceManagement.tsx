import React, { useState, useRef } from 'react';
import { 
  Plus, Save, Download, Upload, Network, Settings2, Trash2, Shield, Key, 
  FileCheck, CheckCircle2, List, Terminal, Play, Square, Filter, ArrowRight, 
  ArrowLeft, Activity, Wifi, Check, X, Edit2, Search, AlertCircle, RefreshCw, 
  HelpCircle, Server, Cpu, Globe, Radio, Layers, Zap, Database, Lock, Eye
} from 'lucide-react';
import { Protocol, PROTOCOL_CONFIGS, ProtocolMetadata } from '../protocolConfig';

export interface TagMapping {
  id: string;
  variableName: string;
  address: string;
  dataType: string;
  unit: string;
  description: string;
  scale?: number;
  offset?: number;
}

export interface Device {
  id: string;
  channel: string;
  protocol: Protocol;
  ip: string;
  port: string;
  status: 'Connected' | 'Disconnected';
  tags: TagMapping[];
  
  // Siemens Profinet / S7 specific
  rack?: number;
  slot?: number;
  s7Model?: string;
  s7ConnectionType?: string;
  pduSize?: number;

  // OPC UA specific
  endpointUrl?: string;
  securityMode?: string;
  securityPolicy?: string;
  authType?: string;
  username?: string;
  password?: string;
  publishInterval?: number;

  // Modbus TCP specific
  slaveId?: number;
  byteOrder32?: string;
  byteOrder64?: string;
  addressingModel?: string;
  maxHoldingRegisters?: number;

  // Rockwell EtherNet/IP CIP specific
  cipPath?: string;
  cipSlot?: number;
  cipConnectionType?: string;
  cipPlcType?: string;

  // Mitsubishi MELSEC specific
  mcFrame?: string;
  networkNo?: number;
  stationNo?: number;
  dstModuleIoNo?: string;
  cpuTimer?: number;
  melsecSeries?: string;

  // Omron FINS specific
  finsTransport?: string;
  srcNet?: number;
  srcNode?: number;
  srcUnit?: number;
  dstNet?: number;
  dstNode?: number;
  dstUnit?: number;
  finsModel?: string;

  // MQTT / Sparkplug B specific
  brokerUrl?: string;
  clientId?: string;
  sparkplugGroupId?: string;
  sparkplugNodeId?: string;
  sparkplugDeviceId?: string;
  mqttQos?: number;
  mqttPayloadFormat?: string;
  mqttKeepAlive?: number;
  mqttCleanSession?: boolean;
  mqttTls?: boolean;

  // BACnet/IP specific
  bacnetDeviceId?: number;
  bacnetNetwork?: number;
  bacnetMaxApdu?: number;
  bacnetSegmentation?: string;
  bacnetBbmdIp?: string;

  // IEC 60870-5-104 specific
  asduAddress?: number;
  cotSize?: number;
  ioaSize?: number;
  t1Timeout?: number;
  t2Timeout?: number;
  t3Timeout?: number;
}

const initialDevices: Device[] = [
  {
    id: 'd1',
    channel: 'R0021_S7_1500',
    protocol: 'Siemens Profinet',
    ip: '192.168.1.100',
    port: '102',
    rack: 0,
    slot: 1,
    s7Model: 'S7-1500',
    s7ConnectionType: 'OP',
    pduSize: 480,
    status: 'Connected',
    tags: [
      { id: 't1', variableName: 'R0021.pH', address: 'DB301.Real10', dataType: 'Float', unit: 'pH', description: 'Reactor pH level', scale: 1, offset: 0 },
      { id: 't2', variableName: 'R0021.Temperature', address: 'DB301.Real14', dataType: 'Float', unit: '°C', description: 'Reactor Temp', scale: 0.1, offset: 0 },
      { id: 't3', variableName: 'R0021.alm1', address: 'DB301.DBX20.0', dataType: 'Bool', unit: '', description: 'Alarm 1 Status', scale: 1, offset: 0 },
    ]
  },
  {
    id: 'd2',
    channel: 'R0022_Modbus_Drive',
    protocol: 'Modbus TCP',
    ip: '192.168.1.105',
    port: '502',
    status: 'Connected',
    slaveId: 1,
    byteOrder32: 'CDAB',
    byteOrder64: 'GHEFCDAB',
    addressingModel: '0',
    maxHoldingRegisters: 120,
    tags: [
      { id: 't4', variableName: 'R0022.Speed', address: '40001', dataType: 'Int16', unit: 'RPM', description: 'Motor Speed', scale: 1, offset: 0 },
      { id: 't5', variableName: 'R0022.Status', address: '40002', dataType: 'Int16', unit: '', description: 'Running Status', scale: 1, offset: 0 },
      { id: 't6', variableName: 'R0022.Current', address: '40003', dataType: 'Float', unit: 'A', description: 'Inverter output current', scale: 0.1, offset: 0 },
    ]
  },
  {
    id: 'd3',
    channel: 'OPC_UA_Server',
    protocol: 'OPC UA',
    ip: '192.168.1.200',
    port: '4840',
    status: 'Connected',
    endpointUrl: 'opc.tcp://192.168.1.200:4840/UA/FactoryServer',
    securityMode: 'SignAndEncrypt',
    securityPolicy: 'Basic256Sha256',
    authType: 'Anonymous',
    publishInterval: 250,
    tags: [
      { id: 't7', variableName: 'Main.Pressure', address: 'ns=3;s="DB_Process"."Pressure"', dataType: 'Float', unit: 'bar', description: 'Main line pressure', scale: 1, offset: 0 },
      { id: 't8', variableName: 'Main.FlowRate', address: 'ns=3;s="DB_Process"."FlowRate"', dataType: 'Float', unit: 'L/min', description: 'Coolant flow rate', scale: 1, offset: 0 },
    ]
  },
  {
    id: 'd4',
    channel: 'AB_ControlLogix_Line1',
    protocol: 'EtherNet/IP (Rockwell)',
    ip: '192.168.1.110',
    port: '44818',
    status: 'Connected',
    cipPath: '1,0',
    cipSlot: 0,
    cipPlcType: 'ControlLogix 5580',
    cipConnectionType: 'Connected (Class 3)',
    tags: [
      { id: 't9', variableName: 'Line1.ConveyorSpeed', address: 'Program:MainProgram.Conveyor_Speed_SP', dataType: 'Float', unit: 'm/s', description: 'Main Belt Speed', scale: 1, offset: 0 },
      { id: 't10', variableName: 'Line1.PartCount', address: 'Global_Part_Counter_Total', dataType: 'Int32', unit: 'pcs', description: 'Shift Good Parts', scale: 1, offset: 0 },
      { id: 't11', variableName: 'Line1.EStop', address: 'Safety_Zone1_EStop_OK', dataType: 'Bool', unit: '', description: 'Emergency circuit status', scale: 1, offset: 0 }
    ]
  },
  {
    id: 'd5',
    channel: 'Mitsu_FX5U_Packer',
    protocol: 'Mitsubishi MELSEC',
    ip: '192.168.1.130',
    port: '5000',
    status: 'Connected',
    mcFrame: '3E Frame (Binary)',
    melsecSeries: 'iQ-F (FX5U)',
    networkNo: 1,
    stationNo: 1,
    dstModuleIoNo: '03FF',
    cpuTimer: 250,
    tags: [
      { id: 't12', variableName: 'Packer.SealTemp', address: 'D100', dataType: 'Float', unit: '°C', description: 'Heat Sealer Temperature', scale: 0.1, offset: 0 },
      { id: 't13', variableName: 'Packer.CylinderCycle', address: 'D102', dataType: 'Int32', unit: 'ms', description: 'Pneumatic stroke cycle time', scale: 1, offset: 0 },
      { id: 't14', variableName: 'Packer.ReadyFlag', address: 'M10', dataType: 'Bool', unit: '', description: 'Auto Cycle Ready', scale: 1, offset: 0 }
    ]
  },
  {
    id: 'd6',
    channel: 'Omron_CJ2_Welder',
    protocol: 'Omron FINS',
    ip: '192.168.1.140',
    port: '9600',
    status: 'Connected',
    finsTransport: 'TCP',
    finsModel: 'CJ2 / CS1',
    srcNet: 0,
    srcNode: 1,
    srcUnit: 0,
    dstNet: 0,
    dstNode: 10,
    dstUnit: 0,
    tags: [
      { id: 't15', variableName: 'Welder.Voltage', address: 'DM100', dataType: 'Float', unit: 'V', description: 'Arc Voltage Feedback', scale: 0.1, offset: 0 },
      { id: 't16', variableName: 'Welder.WeldCurrent', address: 'DM102', dataType: 'Float', unit: 'A', description: 'Primary Weld Current', scale: 0.5, offset: 0 },
      { id: 't17', variableName: 'Welder.ArcOK', address: 'CIO100.01', dataType: 'Bool', unit: '', description: 'Arc Stable Signal', scale: 1, offset: 0 }
    ]
  },
  {
    id: 'd7',
    channel: 'Sparkplug_Edge_Node',
    protocol: 'MQTT / Sparkplug B',
    ip: '10.0.10.50',
    port: '1883',
    status: 'Connected',
    brokerUrl: 'mqtt://10.0.10.50:1883',
    clientId: 'Industrial_Edge_Gateway_01',
    sparkplugGroupId: 'Plant_East',
    sparkplugNodeId: 'Line_Cell_01',
    sparkplugDeviceId: 'Robotic_Arm_A',
    mqttQos: 1,
    mqttPayloadFormat: 'Sparkplug B (Protobuf)',
    mqttKeepAlive: 60,
    mqttCleanSession: true,
    mqttTls: false,
    tags: [
      { id: 't18', variableName: 'Robot.Joint1_Torque', address: 'spBv1.0/Plant_East/DDATA/Line_Cell_01/Robotic_Arm_A/J1_Torque', dataType: 'Float', unit: 'Nm', description: 'Axis 1 Actual Torque', scale: 1, offset: 0 },
      { id: 't19', variableName: 'Robot.CycleProgress', address: 'spBv1.0/Plant_East/DDATA/Line_Cell_01/Robotic_Arm_A/CyclePct', dataType: 'Int16', unit: '%', description: 'Motion Execution Progress', scale: 1, offset: 0 }
    ]
  },
  {
    id: 'd8',
    channel: 'HVAC_Building_Chiller',
    protocol: 'BACnet/IP',
    ip: '192.168.20.10',
    port: '47808',
    status: 'Connected',
    bacnetDeviceId: 1001,
    bacnetNetwork: 0,
    bacnetMaxApdu: 1476,
    bacnetSegmentation: 'Both',
    tags: [
      { id: 't20', variableName: 'Chiller.ChilledWaterSupplyTemp', address: 'AI:1', dataType: 'Float', unit: '°C', description: 'Chilled Water Supply Temp', scale: 1, offset: 0 },
      { id: 't21', variableName: 'Chiller.ReturnWaterTemp', address: 'AI:2', dataType: 'Float', unit: '°C', description: 'Chilled Water Return Temp', scale: 1, offset: 0 },
      { id: 't22', variableName: 'Chiller.CompressorStatus', address: 'BI:1', dataType: 'Bool', unit: '', description: 'Compressor 1 Running', scale: 1, offset: 0 }
    ]
  }
];

export default function DeviceManagement() {
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [activeDeviceId, setActiveDeviceId] = useState<string>(initialDevices[0].id);
  const [activeTab, setActiveTab] = useState<'connection' | 'tags' | 'diagnostics'>('connection');
  const [protocolFilter, setProtocolFilter] = useState<string>('All');

  // Add Device Modal State
  const [isAddDeviceOpen, setIsAddDeviceOpen] = useState(false);
  const [newDeviceChannel, setNewDeviceChannel] = useState('');
  const [newDeviceProtocol, setNewDeviceProtocol] = useState<Protocol>('Siemens Profinet');
  const [newDeviceIp, setNewDeviceIp] = useState('192.168.1.120');
  const [newDevicePort, setNewDevicePort] = useState('102');
  const [newDeviceRack, setNewDeviceRack] = useState(0);
  const [newDeviceSlot, setNewDeviceSlot] = useState(1);

  // Tag Management State
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<TagMapping | null>(null);
  const [tagSearch, setTagSearch] = useState('');
  const [tagForm, setTagForm] = useState<Omit<TagMapping, 'id'>>({
    variableName: '',
    address: '',
    dataType: 'Float',
    unit: '',
    description: '',
    scale: 1,
    offset: 0
  });

  // Connection Test State
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    status: 'success' | 'error';
    latency: number;
    message: string;
    details: string;
    protocolSummary: string;
  } | null>(null);

  // Save Toast Feedback
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeDevice = devices.find(d => d.id === activeDeviceId) || devices[0];

  const showToast = (message: string) => {
    setSaveToast(message);
    setTimeout(() => {
      setSaveToast(null);
    }, 3000);
  };

  const updateActiveDevice = (updates: Partial<Device>) => {
    setDevices(prev => prev.map(dev => dev.id === activeDeviceId ? { ...dev, ...updates } : dev));
  };

  const handleProtocolSelectInModal = (proto: Protocol) => {
    setNewDeviceProtocol(proto);
    const meta = PROTOCOL_CONFIGS[proto];
    setNewDevicePort(meta.defaultPort);
  };

  // Create new Device Node
  const handleCreateDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceChannel.trim()) return;

    const meta = PROTOCOL_CONFIGS[newDeviceProtocol];
    const newId = `dev_${Date.now()}`;
    const newDev: Device = {
      id: newId,
      channel: newDeviceChannel.trim(),
      protocol: newDeviceProtocol,
      ip: newDeviceIp.trim() || '127.0.0.1',
      port: newDevicePort.trim() || meta.defaultPort,
      rack: newDeviceProtocol === 'Siemens Profinet' ? newDeviceRack : undefined,
      slot: newDeviceProtocol === 'Siemens Profinet' ? newDeviceSlot : undefined,
      status: 'Connected',
      tags: [
        {
          id: `tag_${Date.now()}_1`,
          variableName: `${newDeviceChannel.trim()}.Status`,
          address: meta.sampleAddress,
          dataType: 'Float',
          unit: '',
          description: 'Primary telemetry status point',
          scale: 1,
          offset: 0
        }
      ]
    };

    setDevices(prev => [...prev, newDev]);
    setActiveDeviceId(newId);
    setIsAddDeviceOpen(false);
    showToast(`Device node "${newDev.channel}" created with ${newDev.protocol} driver.`);
  };

  // Delete current active device
  const handleDeleteDevice = (id: string) => {
    if (devices.length <= 1) {
      showToast('Cannot delete the only remaining bridge node.');
      return;
    }
    const devToDelete = devices.find(d => d.id === id);
    const remaining = devices.filter(d => d.id !== id);
    setDevices(remaining);
    setActiveDeviceId(remaining[0].id);
    showToast(`Device "${devToDelete?.channel}" removed.`);
  };

  // Test Connection
  const handleTestConnection = () => {
    setIsTestingConnection(true);
    setTestResult(null);

    setTimeout(() => {
      setIsTestingConnection(false);
      const isIpValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(activeDevice.ip) || activeDevice.ip.includes('localhost') || activeDevice.ip.startsWith('mqtt');
      const meta = PROTOCOL_CONFIGS[activeDevice.protocol];
      
      if (isIpValid) {
        const simulatedLatency = Math.floor(Math.random() * 12) + 4;
        let details = '';
        let protocolSummary = '';

        switch (activeDevice.protocol) {
          case 'Siemens Profinet':
            details = `ISO-on-TCP TPKT Layer OK. COTP Connection Confirm (0xD0) received. S7comm negotiated PDU Size: ${activeDevice.pduSize || 480} bytes. Rack ${activeDevice.rack ?? 0}, Slot ${activeDevice.slot ?? 1} CPU is in RUN mode.`;
            protocolSummary = `S7-1500 / ISO-on-TCP RFC1006 Handshake Verified`;
            break;
          case 'OPC UA':
            details = `TCP Handshake HEL/ACK successful. Secure Channel established (SecurityPolicy: ${activeDevice.securityPolicy || 'Basic256Sha256'}). Session activated with Anonymous token. Endpoints: 1 found.`;
            protocolSummary = `OPC UA IEC 62541 Service Level 255 (Optimal)`;
            break;
          case 'Modbus TCP':
            details = `MBAP Header transaction test passed. Function Code 03 (Read Holding Registers) responded from Slave ID ${activeDevice.slaveId || 1}. Byte order: ${activeDevice.byteOrder32 || 'CDAB'}.`;
            protocolSummary = `Modbus TCP Slave Response OK (Unit ${activeDevice.slaveId || 1})`;
            break;
          case 'EtherNet/IP (Rockwell)':
            details = `CIP RegisterSession (0x0065) success. Session Handle: 0x00045A12. Forward_Open request accepted on Path [${activeDevice.cipPath || '1,0'}]. PLC: ${activeDevice.cipPlcType || 'ControlLogix'}.`;
            protocolSummary = `Rockwell CIP Class 3 Connection Established`;
            break;
          case 'Mitsubishi MELSEC':
            details = `SLMP / MC 3E Frame header confirmed. End code 0x0000 (Normal Completion). Target CPU Series: ${activeDevice.melsecSeries || 'iQ-F'}. Station ${activeDevice.stationNo || 1}.`;
            protocolSummary = `MELSEC 3E Frame Communication Normal`;
            break;
          case 'Omron FINS':
            details = `FINS Node Address Data Send (0x00000000) resolved. Server assigned Node ${activeDevice.dstNode || 10}. CPU Status: RUN mode, Memory DM0-DM32767 accessible.`;
            protocolSummary = `FINS Gateway Handshake Successful`;
            break;
          case 'MQTT / Sparkplug B':
            details = `MQTT CONNACK (Return Code 0: Connection Accepted). Sparkplug B NBIRTH packet published for Group "${activeDevice.sparkplugGroupId || 'Plant'}" Node "${activeDevice.sparkplugNodeId || 'Node1'}".`;
            protocolSummary = `MQTT Broker Connected & Sparkplug B NBIRTH Active`;
            break;
          case 'BACnet/IP':
            details = `BVLC Original-Unicast-NPDU received. I-Am response matched Device Instance #${activeDevice.bacnetDeviceId || 1001}. APDU Max Length: ${activeDevice.bacnetMaxApdu || 1476} bytes.`;
            protocolSummary = `BACnet/IP Device #${activeDevice.bacnetDeviceId || 1001} Online`;
            break;
          case 'IEC 60870-5-104':
            details = `STARTDT ACT / CON confirmed. Common ASDU Address: ${activeDevice.asduAddress || 1}. Telecontrol transmission active.`;
            protocolSummary = `IEC 104 Link Layer Active`;
            break;
        }

        setTestResult({
          status: 'success',
          latency: simulatedLatency,
          message: `Connected successfully to ${activeDevice.channel} via ${activeDevice.protocol}`,
          details,
          protocolSummary
        });
        updateActiveDevice({ status: 'Connected' });
      } else {
        setTestResult({
          status: 'error',
          latency: 0,
          message: `Failed to reach endpoint at ${activeDevice.ip}:${activeDevice.port}`,
          details: 'Socket timeout error: No TCP SYN-ACK received within 3000ms. Check IP routing, physical cabling, firewall rules, and target port accessibility.',
          protocolSummary: 'TCP Connection Refused / Unreachable'
        });
        updateActiveDevice({ status: 'Disconnected' });
      }
    }, 600);
  };

  // Tag Management
  const openAddTagModal = () => {
    setEditingTag(null);
    const meta = PROTOCOL_CONFIGS[activeDevice.protocol];
    setTagForm({
      variableName: '',
      address: meta.sampleAddress,
      dataType: 'Float',
      unit: '',
      description: '',
      scale: 1,
      offset: 0
    });
    setIsTagModalOpen(true);
  };

  const openEditTagModal = (tag: TagMapping) => {
    setEditingTag(tag);
    setTagForm({
      variableName: tag.variableName,
      address: tag.address,
      dataType: tag.dataType,
      unit: tag.unit,
      description: tag.description,
      scale: tag.scale ?? 1,
      offset: tag.offset ?? 0
    });
    setIsTagModalOpen(true);
  };

  const handleSaveTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tagForm.variableName.trim() || !tagForm.address.trim()) return;

    if (editingTag) {
      const updatedTags = activeDevice.tags.map(t => 
        t.id === editingTag.id 
          ? { ...t, ...tagForm }
          : t
      );
      updateActiveDevice({ tags: updatedTags });
      showToast(`Tag "${tagForm.variableName}" updated.`);
    } else {
      const newTag: TagMapping = {
        id: `tag_${Date.now()}`,
        ...tagForm
      };
      updateActiveDevice({ tags: [...activeDevice.tags, newTag] });
      showToast(`New tag "${tagForm.variableName}" added.`);
    }
    setIsTagModalOpen(false);
  };

  const handleDeleteTag = (tagId: string) => {
    const tagToDelete = activeDevice.tags.find(t => t.id === tagId);
    const updatedTags = activeDevice.tags.filter(t => t.id !== tagId);
    updateActiveDevice({ tags: updatedTags });
    showToast(`Tag "${tagToDelete?.variableName}" deleted.`);
  };

  // Export CSV
  const handleExportCsv = () => {
    const headers = ['VariableName', 'Address', 'DataType', 'Unit', 'Scale', 'Offset', 'Description'];
    const rows = activeDevice.tags.map(t => [
      `"${t.variableName}"`,
      `"${t.address}"`,
      `"${t.dataType}"`,
      `"${t.unit}"`,
      t.scale ?? 1,
      t.offset ?? 0,
      `"${t.description.replace(/"/g, '""')}"`
    ].join(','));

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${activeDevice.channel}_tags_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Exported ${activeDevice.tags.length} tags to CSV.`);
  };

  // Import CSV
  const handleImportCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (!content) return;

      const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
      if (lines.length <= 1) {
        showToast('CSV file is empty or missing data rows.');
        return;
      }

      const importedTags: TagMapping[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        if (parts.length >= 2) {
          importedTags.push({
            id: `tag_import_${Date.now()}_${i}`,
            variableName: parts[0] || `Tag_${i}`,
            address: parts[1] || '40001',
            dataType: parts[2] || 'Float',
            unit: parts[3] || '',
            scale: parseFloat(parts[4]) || 1,
            offset: parseFloat(parts[5]) || 0,
            description: parts[6] || 'Imported via CSV'
          });
        }
      }

      if (importedTags.length > 0) {
        updateActiveDevice({ tags: [...activeDevice.tags, ...importedTags] });
        showToast(`Successfully imported ${importedTags.length} tags from CSV.`);
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  const filteredDevices = devices.filter(dev => {
    if (protocolFilter === 'All') return true;
    return dev.protocol === protocolFilter;
  });

  const filteredTags = activeDevice.tags.filter(t => 
    t.variableName.toLowerCase().includes(tagSearch.toLowerCase()) ||
    t.address.toLowerCase().includes(tagSearch.toLowerCase()) ||
    t.description.toLowerCase().includes(tagSearch.toLowerCase())
  );

  const activeMeta = PROTOCOL_CONFIGS[activeDevice.protocol];

  // Helper for dynamic diagnostic hex frames
  const getDiagnosticLogs = () => {
    switch (activeDevice.protocol) {
      case 'Siemens Profinet':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '03 00 00 1F 02 F0 80 32 01 00 00 00 01 00 0E 00 00 04 01 12 0A 10 02 00 04 01 2D 84 00 50', desc: 'Read DB301.Real10 (4 bytes)' },
          { time: '10:45:21.050', dir: 'RX', hex: '03 00 00 19 02 F0 80 32 03 00 00 00 01 00 02 00 08 00 00 04 01 FF 04 00 20 40 E6 66 66', desc: 'S7comm Data Response: 7.20 pH' },
          { time: '10:45:22.042', dir: 'TX', hex: '03 00 00 1F 02 F0 80 32 01 00 00 00 02 00 0E 00 00 04 01 12 0A 10 02 00 04 01 2D 84 00 70', desc: 'Read DB301.Real14 (Temp)' },
          { time: '10:45:22.052', dir: 'RX', hex: '03 00 00 19 02 F0 80 32 03 00 00 00 02 00 02 00 08 00 00 04 01 FF 04 00 20 42 0E 00 00', desc: 'S7comm Data Response: 35.5 °C' }
        ];
      case 'OPC UA':
        return [
          { time: '10:45:21.110', dir: 'TX', hex: '4F 50 4E 46 72 00 00 00 01 00 00 00 01 00 00 00 ... 53 69 67 6E 41 6E 64 45 6E 63 72 79 70 74', desc: 'OPC UA OpenSecureChannel (SignAndEncrypt)' },
          { time: '10:45:21.125', dir: 'RX', hex: '4F 50 4E 46 84 00 00 00 01 00 00 00 01 00 00 00 ... 00 00 00 00 (Security Token Issued)', desc: 'OpenSecureChannel Response OK' },
          { time: '10:45:22.040', dir: 'TX', hex: '4D 53 47 46 58 00 00 00 01 00 00 00 ... ReadRequest [ns=3;s="DB_Process"."Pressure"]', desc: 'ReadRequest NodesToRead=2' },
          { time: '10:45:22.058', dir: 'RX', hex: '4D 53 47 46 6C 00 00 00 01 00 00 00 ... DataValue: Float 1.20 bar (Good)', desc: 'ReadResponse StatusCode=0x00000000' }
        ];
      case 'EtherNet/IP (Rockwell)':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '6F 00 1E 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 52 02', desc: 'SendRRData CIP Read Tag "Conveyor_Speed"' },
          { time: '10:45:21.054', dir: 'RX', hex: '6F 00 22 00 01 00 00 00 00 00 00 00 00 00 00 00 ... CC 00 00 00 CA 00 40 40 00 00', desc: 'CIP Success (0x00) Value: REAL 3.0 m/s' },
          { time: '10:45:22.042', dir: 'TX', hex: '6F 00 24 00 01 00 00 00 ... CIP Read Tag "Global_Part_Counter_Total"', desc: 'SendRRData CIP Read DINT' },
          { time: '10:45:22.050', dir: 'RX', hex: '6F 00 20 00 01 00 00 00 ... CC 00 00 00 C4 00 5A 0F 00 00', desc: 'CIP Success Value: DINT 3930 pcs' }
        ];
      case 'Mitsubishi MELSEC':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '50 00 00 FF FF 03 00 0C 00 10 00 01 04 00 00 64 00 00 A8 02 00', desc: 'MC 3E Frame: Read D100, Points=2' },
          { time: '10:45:21.052', dir: 'RX', hex: 'D0 00 00 FF FF 03 00 06 00 00 00 5E 01 00 00', desc: 'MC Response: EndCode=0x0000, D100=350 (35.0°C)' },
          { time: '10:45:22.042', dir: 'TX', hex: '50 00 00 FF FF 03 00 0C 00 10 00 01 04 01 00 0A 00 00 90 01 00', desc: 'MC 3E Frame: Read Bit M10' },
          { time: '10:45:22.049', dir: 'RX', hex: 'D0 00 00 FF FF 03 00 03 00 00 00 10', desc: 'MC Response: M10=1 (Bit ON)' }
        ];
      case 'Omron FINS':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '46 49 4E 53 00 00 00 1A 00 00 00 02 00 00 00 00 80 00 02 00 00 00 00 0A 00 00 01 01 82 00 64 00 00 02', desc: 'FINS 0101 Memory Area Read (DM100, 2 words)' },
          { time: '10:45:21.051', dir: 'RX', hex: '46 49 4E 53 00 00 00 1A 00 00 00 02 00 00 00 00 C0 00 02 00 0A 00 00 01 00 00 01 01 00 00 00 DE 01 2C', desc: 'FINS 0000 Normal End: Data 0x00DE, 0x012C' }
        ];
      case 'MQTT / Sparkplug B':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '30 4E 00 3C 73 70 42 76 31 2E 30 2F 50 6C 61 6E 74 5F 45 61 73 74 2F 44 44 41 54 41 ...', desc: 'MQTT PUBLISH [spBv1.0/Plant_East/DDATA/Line_Cell_01/Robotic_Arm_A] QoS:1' },
          { time: '10:45:21.052', dir: 'RX', hex: '40 02 00 12', desc: 'MQTT PUBACK (Packet ID: 18)' },
          { time: '10:45:22.042', dir: 'TX', hex: '30 22 00 16 66 61 63 74 6F 72 79 2F 6C 69 6E 65 31 2F 73 74 61 74 75 73 {"state":"RUN"}', desc: 'MQTT Telemetry JSON Publish' }
        ];
      case 'BACnet/IP':
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '81 0A 00 11 01 04 00 00 00 0C 0C 00 00 00 01 19 55', desc: 'BVLC Original-Unicast-NPDU: ReadProperty (AI:1, Present_Value)' },
          { time: '10:45:21.055', dir: 'RX', hex: '81 0A 00 15 01 00 30 01 0E 0C 00 00 00 01 19 55 3E 44 41 20 00 00 3F', desc: 'ComplexACK: AI:1 Present_Value = 7.0 °C' }
        ];
      default: // Modbus TCP
        return [
          { time: '10:45:21.042', dir: 'TX', hex: '00 01 00 00 00 06 01 03 00 00 00 0A', desc: 'Read Holding Registers [40001, len=10]' },
          { time: '10:45:21.058', dir: 'RX', hex: '00 01 00 00 00 17 01 03 14 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14', desc: 'Modbus Data Response (20 bytes)' },
          { time: '10:45:22.043', dir: 'TX', hex: '00 02 00 00 00 06 01 06 00 00 04 B0', desc: 'Write Single Register 40001 = 1200 (RPM)' },
          { time: '10:45:22.059', dir: 'RX', hex: '00 02 00 00 00 06 01 06 00 00 04 B0', desc: 'Write Confirmation OK' }
        ];
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-100 relative">
      {/* Toast notification */}
      {saveToast && (
        <div className="absolute top-4 right-4 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{saveToast}</span>
        </div>
      )}

      {/* Hidden file input for CSV Import */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImportCsv} 
        accept=".csv" 
        className="hidden" 
      />

      <div className="flex-1 flex overflow-hidden">
        {/* LEFT SIDEBAR: Device Bridge Nodes List */}
        <div className="w-80 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-indigo-600" />
                <h3 className="font-bold text-slate-800 text-sm">Industrial Bridges</h3>
              </div>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                {devices.length} Nodes
              </span>
            </div>

            {/* Quick protocol filter */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px] scrollbar-none">
              {['All', 'Siemens Profinet', 'OPC UA', 'Modbus TCP', 'EtherNet/IP (Rockwell)', 'MQTT / Sparkplug B'].map(proto => (
                <button
                  key={proto}
                  onClick={() => setProtocolFilter(proto)}
                  className={`px-2 py-1 rounded whitespace-nowrap font-medium transition-colors ${
                    protocolFilter === proto
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-200/70 border border-slate-200'
                  }`}
                >
                  {proto === 'All' ? 'All' : proto.split(' ')[0]}
                </button>
              ))}
            </div>

            <button 
              onClick={() => setIsAddDeviceOpen(true)}
              className="w-full mt-3 flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-sm transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add Protocol Node
            </button>
          </div>

          {/* Device Nodes List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredDevices.map(device => {
              const isSelected = device.id === activeDeviceId;
              const meta = PROTOCOL_CONFIGS[device.protocol] || PROTOCOL_CONFIGS['Modbus TCP'];
              return (
                <div
                  key={device.id}
                  onClick={() => setActiveDeviceId(device.id)}
                  className={`p-3.5 cursor-pointer transition-all ${
                    isSelected 
                      ? 'bg-indigo-50/70 border-l-4 border-indigo-600' 
                      : 'hover:bg-slate-50 border-l-4 border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-bold text-slate-800 text-xs truncate max-w-[160px]">{device.channel}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.color}`}>
                      {device.protocol.split(' ')[0]}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                    <span className="truncate">{device.ip}:{device.port}</span>
                    <span className="text-[10px] font-sans font-semibold text-slate-400">
                      {device.tags.length} tags
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px]">
                    <span className="flex items-center gap-1 text-slate-400 truncate max-w-[180px]">
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.bgColor}`}></span>
                      {meta.vendor}
                    </span>
                    <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      Online
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* MAIN WORKSPACE */}
        <div className="flex-1 flex flex-col overflow-hidden bg-white">
          {/* Top Bar Header */}
          <div className="px-6 py-4 border-b border-slate-200 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
            <div>
              <div className="flex items-center gap-2.5">
                <div className={`p-1.5 rounded-lg border ${activeMeta.color}`}>
                  <Zap className="w-4 h-4" />
                </div>
                <h2 className="text-base font-bold text-slate-900">{activeDevice.channel}</h2>
                <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${activeMeta.color}`}>
                  {activeDevice.protocol}
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  {activeDevice.status}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 font-mono">
                {activeMeta.vendor} | Endpoint: <span className="text-slate-800 font-semibold">{activeDevice.ip}:{activeDevice.port}</span> | Standard: <span className="text-slate-600">{activeMeta.standard}</span>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button 
                onClick={() => handleDeleteDevice(activeDevice.id)}
                className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
                title="Delete this bridge node"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Node
              </button>
              <button 
                onClick={() => showToast(`All parameters and ${activeDevice.tags.length} tag mappings saved.`)}
                className="px-4 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" /> Save Configuration
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex border-b border-slate-200 bg-slate-50 px-6 shrink-0">
            <button
              onClick={() => setActiveTab('connection')}
              className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
                activeTab === 'connection'
                  ? 'border-indigo-600 text-indigo-600 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Network className="w-4 h-4" /> Connection & Protocol Parameters
            </button>
            <button
              onClick={() => setActiveTab('tags')}
              className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
                activeTab === 'tags'
                  ? 'border-indigo-600 text-indigo-600 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <List className="w-4 h-4" /> Point Map & Scaling ({activeDevice.tags.length})
            </button>
            <button
              onClick={() => setActiveTab('diagnostics')}
              className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
                activeTab === 'diagnostics'
                  ? 'border-indigo-600 text-indigo-600 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Terminal className="w-4 h-4" /> Protocol Packet Diagnostics
            </button>
          </div>

          {/* TAB 1: Connection & Protocol Parameters */}
          {activeTab === 'connection' && (
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Channel Communication Test Panel */}
              <div className="bg-gradient-to-r from-slate-50 to-indigo-50/40 p-5 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                      <Radio className="w-4 h-4 text-indigo-600" />
                      Protocol Communication Handshake Test
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Execute full round-trip ping and protocol-level frame exchange with <span className="font-semibold text-slate-700">{activeDevice.ip}:{activeDevice.port}</span>.
                    </p>
                  </div>
                  <button
                    onClick={handleTestConnection}
                    disabled={isTestingConnection}
                    className={`px-4 py-2 rounded-lg text-xs font-bold shadow-sm transition-all flex items-center gap-2 shrink-0 ${
                      isTestingConnection 
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
                    }`}
                  >
                    {isTestingConnection ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Probing Driver...
                      </>
                    ) : (
                      <>
                        <Wifi className="w-3.5 h-3.5" />
                        Test Connection Now
                      </>
                    )}
                  </button>
                </div>

                {/* Test Result Display */}
                {testResult && (
                  <div className={`mt-4 p-4 rounded-lg border text-xs animate-in fade-in slide-in-from-top-2 ${
                    testResult.status === 'success'
                      ? 'bg-emerald-50/90 border-emerald-300 text-emerald-950'
                      : 'bg-rose-50/90 border-rose-300 text-rose-950'
                  }`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 font-bold text-sm">
                        {testResult.status === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        )}
                        <span>{testResult.message}</span>
                      </div>
                      {testResult.latency > 0 && (
                        <span className="font-mono px-2 py-0.5 rounded bg-emerald-200 text-emerald-900 font-bold">
                          RTT: {testResult.latency} ms
                        </span>
                      )}
                    </div>
                    <div className="mt-2 font-semibold text-slate-700">{testResult.protocolSummary}</div>
                    <p className="mt-1 text-slate-600 leading-relaxed font-mono text-[11px]">{testResult.details}</p>
                  </div>
                )}
              </div>

              {/* General Network Parameters */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Network className="w-4 h-4 text-indigo-600" />
                    <h4 className="font-bold text-slate-800 text-sm">Network Layer Parameters</h4>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-mono">
                    TCP/IP Socket
                  </span>
                </div>
                <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-5">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Bridge Channel Name</label>
                    <input 
                      type="text" 
                      value={activeDevice.channel}
                      onChange={(e) => updateActiveDevice({ channel: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Target IPv4 Address / Hostname</label>
                    <input 
                      type="text" 
                      value={activeDevice.ip}
                      onChange={(e) => updateActiveDevice({ ip: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Target Port</label>
                    <input 
                      type="text" 
                      value={activeDevice.port}
                      onChange={(e) => updateActiveDevice({ port: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {/* PROTOCOL SPECIFIC PARAMETERS SECTION */}

              {/* 1. Siemens Profinet / S7 */}
              {activeDevice.protocol === 'Siemens Profinet' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-cyan-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-cyan-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Siemens S7comm / Profinet Driver Options</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-cyan-100 text-cyan-800 font-mono">ISO-on-TCP RFC1006</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">PLC Family</label>
                      <select 
                        value={activeDevice.s7Model || 'S7-1500'}
                        onChange={(e) => updateActiveDevice({ s7Model: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="S7-1500">S7-1500 (Optimized DB)</option>
                        <option value="S7-1200">S7-1200</option>
                        <option value="S7-300">S7-300</option>
                        <option value="S7-400">S7-400</option>
                        <option value="S7-200 SMART">S7-200 SMART</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Rack Number</label>
                      <input 
                        type="number" 
                        value={activeDevice.rack ?? 0}
                        onChange={(e) => updateActiveDevice({ rack: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">CPU Slot Number</label>
                      <input 
                        type="number" 
                        value={activeDevice.slot ?? 1}
                        onChange={(e) => updateActiveDevice({ slot: parseInt(e.target.value) || 1 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Negotiated PDU Size</label>
                      <select 
                        value={activeDevice.pduSize || 480}
                        onChange={(e) => updateActiveDevice({ pduSize: parseInt(e.target.value) || 480 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="240">240 Bytes (S7-300/200)</option>
                        <option value="480">480 Bytes (S7-1200/1500)</option>
                        <option value="960">960 Bytes (S7-1500 Turbo)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* 2. OPC UA */}
              {activeDevice.protocol === 'OPC UA' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-indigo-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-indigo-600" />
                      <h4 className="font-bold text-slate-800 text-sm">OPC UA Security & Session Stack</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono">IEC 62541</span>
                  </div>
                  <div className="p-5 space-y-5">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Server Endpoint URL</label>
                        <input 
                          type="text" 
                          value={activeDevice.endpointUrl || `opc.tcp://${activeDevice.ip}:${activeDevice.port}/UA/Server`}
                          onChange={(e) => updateActiveDevice({ endpointUrl: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono text-indigo-600 font-semibold"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Publishing Interval (ms)</label>
                        <input 
                          type="number" 
                          value={activeDevice.publishInterval || 250}
                          onChange={(e) => updateActiveDevice({ publishInterval: parseInt(e.target.value) || 250 })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Security Mode</label>
                        <select 
                          value={activeDevice.securityMode || 'SignAndEncrypt'}
                          onChange={(e) => updateActiveDevice({ securityMode: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                        >
                          <option value="None">None (Unsecured)</option>
                          <option value="Sign">Sign</option>
                          <option value="SignAndEncrypt">Sign & Encrypt (Recommended)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Security Policy</label>
                        <select 
                          value={activeDevice.securityPolicy || 'Basic256Sha256'}
                          onChange={(e) => updateActiveDevice({ securityPolicy: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                        >
                          <option value="Basic256Sha256">Basic256Sha256</option>
                          <option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</option>
                          <option value="Basic128Rsa15">Basic128Rsa15 (Legacy)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">User Authentication</label>
                        <select 
                          value={activeDevice.authType || 'Anonymous'}
                          onChange={(e) => updateActiveDevice({ authType: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                        >
                          <option value="Anonymous">Anonymous</option>
                          <option value="UserPassword">Username & Password</option>
                          <option value="Certificate">X.509 Certificate</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 3. Modbus TCP */}
              {activeDevice.protocol === 'Modbus TCP' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-amber-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Settings2 className="w-4 h-4 text-amber-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Modbus Byte Ordering & Register Mapping</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-mono">Modbus-IDA</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Slave / Unit ID</label>
                      <input 
                        type="number" 
                        value={activeDevice.slaveId || 1}
                        onChange={(e) => updateActiveDevice({ slaveId: parseInt(e.target.value) || 1 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">32-bit Byte Order</label>
                      <select 
                        value={activeDevice.byteOrder32 || 'CDAB'}
                        onChange={(e) => updateActiveDevice({ byteOrder32: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="ABCD">ABCD (Big-Endian)</option>
                        <option value="CDAB">CDAB (Word Swap / Modicon)</option>
                        <option value="BADC">BADC (Byte Swap)</option>
                        <option value="DCBA">DCBA (Little-Endian)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Addressing Base</label>
                      <select 
                        value={activeDevice.addressingModel || '0'}
                        onChange={(e) => updateActiveDevice({ addressingModel: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="0">Zero-based (0-65535)</option>
                        <option value="1">One-based (1-65536)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Max Bulk Registers</label>
                      <input 
                        type="number" 
                        value={activeDevice.maxHoldingRegisters || 120}
                        onChange={(e) => updateActiveDevice({ maxHoldingRegisters: parseInt(e.target.value) || 120 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 4. Rockwell EtherNet/IP CIP */}
              {activeDevice.protocol === 'EtherNet/IP (Rockwell)' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-rose-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-rose-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Rockwell CIP Communication Path & Controller</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-mono">ODVA CIP</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Controller Family</label>
                      <select 
                        value={activeDevice.cipPlcType || 'ControlLogix 5580'}
                        onChange={(e) => updateActiveDevice({ cipPlcType: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="ControlLogix 5580">ControlLogix 5580/5570</option>
                        <option value="CompactLogix 5380">CompactLogix 5380/5370</option>
                        <option value="Micro800">Micro850 / Micro870</option>
                        <option value="SLC500 / MicroLogix">SLC 500 / MicroLogix</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">CIP Routing Path</label>
                      <input 
                        type="text" 
                        value={activeDevice.cipPath || '1,0'}
                        onChange={(e) => updateActiveDevice({ cipPath: e.target.value })}
                        placeholder="e.g., 1,0 (Backplane, Slot)"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Processor Slot</label>
                      <input 
                        type="number" 
                        value={activeDevice.cipSlot ?? 0}
                        onChange={(e) => updateActiveDevice({ cipSlot: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">CIP Transport</label>
                      <select 
                        value={activeDevice.cipConnectionType || 'Connected (Class 3)'}
                        onChange={(e) => updateActiveDevice({ cipConnectionType: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="Connected (Class 3)">Class 3 (Connected)</option>
                        <option value="Unconnected (UCMM)">UCMM (Unconnected)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* 5. Mitsubishi MELSEC */}
              {activeDevice.protocol === 'Mitsubishi MELSEC' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-red-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-red-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Mitsubishi SLMP / MC Protocol Configuration</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800 font-mono">MELSEC 3E/1E</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">MC Frame Format</label>
                      <select 
                        value={activeDevice.mcFrame || '3E Frame (Binary)'}
                        onChange={(e) => updateActiveDevice({ mcFrame: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="3E Frame (Binary)">3E Frame (Binary Mode)</option>
                        <option value="3E Frame (ASCII)">3E Frame (ASCII Mode)</option>
                        <option value="1E Frame (Binary)">1E Frame (FX Series)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">PLC Series</label>
                      <select 
                        value={activeDevice.melsecSeries || 'iQ-F (FX5U)'}
                        onChange={(e) => updateActiveDevice({ melsecSeries: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="iQ-R">iQ-R Series</option>
                        <option value="iQ-F (FX5U)">iQ-F (FX5U / FX5UJ)</option>
                        <option value="Q Series">Q Series (Q03UDE, etc.)</option>
                        <option value="L Series">L Series</option>
                        <option value="FX3U-ENET">FX3U + ENET</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Network / Station No</label>
                      <div className="flex gap-2">
                        <input 
                          type="number" 
                          placeholder="Net"
                          value={activeDevice.networkNo ?? 1}
                          onChange={(e) => updateActiveDevice({ networkNo: parseInt(e.target.value) || 1 })}
                          className="w-1/2 px-2 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                        />
                        <input 
                          type="number" 
                          placeholder="Station"
                          value={activeDevice.stationNo ?? 1}
                          onChange={(e) => updateActiveDevice({ stationNo: parseInt(e.target.value) || 1 })}
                          className="w-1/2 px-2 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">CPU Response Timer (ms)</label>
                      <input 
                        type="number" 
                        value={activeDevice.cpuTimer || 250}
                        onChange={(e) => updateActiveDevice({ cpuTimer: parseInt(e.target.value) || 250 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 6. Omron FINS */}
              {activeDevice.protocol === 'Omron FINS' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-blue-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Network className="w-4 h-4 text-blue-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Omron FINS Node Address Routing</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-mono">FINS TCP/UDP</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Transport</label>
                      <select 
                        value={activeDevice.finsTransport || 'TCP'}
                        onChange={(e) => updateActiveDevice({ finsTransport: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="TCP">FINS over TCP (Port 9600)</option>
                        <option value="UDP">FINS over UDP (Port 9600)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Controller Family</label>
                      <select 
                        value={activeDevice.finsModel || 'CJ2 / CS1'}
                        onChange={(e) => updateActiveDevice({ finsModel: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="CJ2 / CS1">CJ2 / CS1 / CJ1M</option>
                        <option value="NJ / NX Series">NJ / NX (via FINS)</option>
                        <option value="CP1H / CP1L">CP1H / CP1L</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Dest Node Address (DNA/DA1)</label>
                      <input 
                        type="number" 
                        value={activeDevice.dstNode ?? 10}
                        onChange={(e) => updateActiveDevice({ dstNode: parseInt(e.target.value) || 10 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Source Node (SNA/SA1)</label>
                      <input 
                        type="number" 
                        value={activeDevice.srcNode ?? 1}
                        onChange={(e) => updateActiveDevice({ srcNode: parseInt(e.target.value) || 1 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 7. MQTT / Sparkplug B */}
              {activeDevice.protocol === 'MQTT / Sparkplug B' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-purple-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-purple-600" />
                      <h4 className="font-bold text-slate-800 text-sm">Industrial MQTT & Sparkplug B Topology</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-mono">ISO 20922</span>
                  </div>
                  <div className="p-5 space-y-5">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Broker URI</label>
                        <input 
                          type="text" 
                          value={activeDevice.brokerUrl || `mqtt://${activeDevice.ip}:${activeDevice.port}`}
                          onChange={(e) => updateActiveDevice({ brokerUrl: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono text-purple-700 font-semibold"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Client Identifier</label>
                        <input 
                          type="text" 
                          value={activeDevice.clientId || 'Industrial_Edge_Gateway_01'}
                          onChange={(e) => updateActiveDevice({ clientId: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Sparkplug Group ID</label>
                        <input 
                          type="text" 
                          value={activeDevice.sparkplugGroupId || 'Plant_East'}
                          onChange={(e) => updateActiveDevice({ sparkplugGroupId: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Edge Node ID</label>
                        <input 
                          type="text" 
                          value={activeDevice.sparkplugNodeId || 'Line_Cell_01'}
                          onChange={(e) => updateActiveDevice({ sparkplugNodeId: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Device ID (Optional)</label>
                        <input 
                          type="text" 
                          value={activeDevice.sparkplugDeviceId || 'Robotic_Arm_A'}
                          onChange={(e) => updateActiveDevice({ sparkplugDeviceId: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 8. BACnet/IP */}
              {activeDevice.protocol === 'BACnet/IP' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-emerald-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-emerald-600" />
                      <h4 className="font-bold text-slate-800 text-sm">BACnet/IP Building Automation Object Model</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono">ASHRAE 135</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Device Instance ID</label>
                      <input 
                        type="number" 
                        value={activeDevice.bacnetDeviceId || 1001}
                        onChange={(e) => updateActiveDevice({ bacnetDeviceId: parseInt(e.target.value) || 1001 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Network Number</label>
                      <input 
                        type="number" 
                        value={activeDevice.bacnetNetwork ?? 0}
                        onChange={(e) => updateActiveDevice({ bacnetNetwork: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Max APDU Length</label>
                      <input 
                        type="number" 
                        value={activeDevice.bacnetMaxApdu || 1476}
                        onChange={(e) => updateActiveDevice({ bacnetMaxApdu: parseInt(e.target.value) || 1476 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Segmentation</label>
                      <select 
                        value={activeDevice.bacnetSegmentation || 'Both'}
                        onChange={(e) => updateActiveDevice({ bacnetSegmentation: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="Both">Both (Transmit & Receive)</option>
                        <option value="Transmit">Transmit Only</option>
                        <option value="Receive">Receive Only</option>
                        <option value="None">None</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* 9. IEC 60870-5-104 */}
              {activeDevice.protocol === 'IEC 60870-5-104' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-100 bg-amber-50/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-amber-700" />
                      <h4 className="font-bold text-slate-800 text-sm">IEC 60870-5-104 Telecontrol ASDU & Timers</h4>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-mono">IEC 104</span>
                  </div>
                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Common ASDU Address</label>
                      <input 
                        type="number" 
                        value={activeDevice.asduAddress || 1}
                        onChange={(e) => updateActiveDevice({ asduAddress: parseInt(e.target.value) || 1 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono font-semibold"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">COT Size (Octets)</label>
                      <select 
                        value={activeDevice.cotSize || 2}
                        onChange={(e) => updateActiveDevice({ cotSize: parseInt(e.target.value) || 2 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="1">1 Octet</option>
                        <option value="2">2 Octets (Standard)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">IOA Size (Octets)</label>
                      <select 
                        value={activeDevice.ioaSize || 3}
                        onChange={(e) => updateActiveDevice({ ioaSize: parseInt(e.target.value) || 3 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                      >
                        <option value="2">2 Octets</option>
                        <option value="3">3 Octets (Standard)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">T1 Connect Timeout (s)</label>
                      <input 
                        type="number" 
                        value={activeDevice.t1Timeout || 15}
                        onChange={(e) => updateActiveDevice({ t1Timeout: parseInt(e.target.value) || 15 })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Tags Management */}
          {activeTab === 'tags' && (
            <div className="flex flex-col h-full bg-white">
              {/* Tags Toolbar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-4 border-b border-slate-200 bg-slate-50 gap-3 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input 
                      type="text" 
                      placeholder="Search points, address, description..." 
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      className="pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 w-64 font-medium"
                    />
                  </div>
                  <span className="text-xs text-slate-500 font-medium">
                    Showing {filteredTags.length} of {activeDevice.tags.length} points
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-300 rounded-md shadow-sm hover:bg-slate-50 transition-colors flex items-center gap-1.5"
                    title="Import CSV tag mapping"
                  >
                    <Upload className="w-3.5 h-3.5 text-slate-500" /> 
                    Import CSV
                  </button>
                  <button 
                    onClick={handleExportCsv}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-300 rounded-md shadow-sm hover:bg-slate-50 transition-colors flex items-center gap-1.5"
                    title="Export CSV tag mapping"
                  >
                    <Download className="w-3.5 h-3.5 text-slate-500" /> 
                    Export CSV
                  </button>
                  <button 
                    onClick={openAddTagModal}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-sm transition-colors flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" /> 
                    Add Tag
                  </button>
                </div>
              </div>

              {/* Protocol Address Guide Banner */}
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs flex items-center justify-between">
                <span className="text-slate-600 font-medium flex items-center gap-1.5 truncate">
                  <HelpCircle className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                  <strong className="text-slate-800">{activeDevice.protocol} Addressing Syntax:</strong>
                  <span className="font-mono text-[11px] text-slate-500 truncate">{activeMeta.addressSyntaxHelp}</span>
                </span>
                <span className="text-[11px] font-mono text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200 shrink-0 ml-2">
                  Sample: {activeMeta.sampleAddress}
                </span>
              </div>

              {/* Tags Table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left border-collapse min-w-[750px]">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold tracking-wider sticky top-0 z-10 shadow-sm border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 border-b border-slate-200">Variable Name (Tag)</th>
                      <th className="px-4 py-3 border-b border-slate-200">Address / NodeID</th>
                      <th className="px-4 py-3 border-b border-slate-200">Data Type</th>
                      <th className="px-4 py-3 border-b border-slate-200">Unit</th>
                      <th className="px-4 py-3 border-b border-slate-200">Scaling</th>
                      <th className="px-4 py-3 border-b border-slate-200">Description</th>
                      <th className="px-4 py-3 border-b border-slate-200 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredTags.length > 0 ? (
                      filteredTags.map((tag) => (
                        <tr key={tag.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-4 py-3 font-bold text-slate-800 font-mono flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                            {tag.variableName}
                          </td>
                          <td className="px-4 py-3 font-mono font-semibold text-indigo-600">{tag.address}</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px] font-semibold border border-slate-200">
                              {tag.dataType}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600 font-medium">{tag.unit || '—'}</td>
                          <td className="px-4 py-3 text-slate-500 font-mono text-[11px]">
                            {tag.scale !== 1 || tag.offset !== 0 ? `×${tag.scale ?? 1} +${tag.offset ?? 0}` : '1:1'}
                          </td>
                          <td className="px-4 py-3 text-slate-600 truncate max-w-xs">{tag.description || '—'}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button 
                                onClick={() => openEditTagModal(tag)}
                                className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded transition-colors"
                                title="Edit tag"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button 
                                onClick={() => handleDeleteTag(tag.id)}
                                className="p-1 text-slate-400 hover:text-rose-600 hover:bg-slate-100 rounded transition-colors"
                                title="Delete tag"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                          <List className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                          <p className="text-sm font-semibold text-slate-600">No tag mappings found</p>
                          <p className="text-xs text-slate-400 mt-1">Click "Add Tag" or "Import CSV" to register points</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Bottom Quick Add Action */}
              <div className="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-center">
                <button 
                  onClick={openAddTagModal}
                  className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-1.5 py-1 px-3 rounded hover:bg-indigo-50 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add New Point to {activeDevice.channel}
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: Diagnostics */}
          {activeTab === 'diagnostics' && (
            <div className="flex flex-col h-full bg-slate-900 text-slate-300">
              {/* Toolbar */}
              <div className="flex items-center justify-between p-3 border-b border-slate-700 bg-slate-800 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="flex bg-slate-900 rounded-md p-1 border border-slate-700">
                    <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-emerald-400 bg-slate-800 rounded shadow-sm">
                      <Play className="w-3.5 h-3.5 fill-current" /> Capture
                    </button>
                    <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-300 transition-colors">
                      <Square className="w-3.5 h-3.5 fill-current" /> Stop
                    </button>
                  </div>
                  <div className="h-4 w-px bg-slate-700"></div>
                  <span className="text-xs text-slate-400 font-mono">
                    Protocol: <span className="text-emerald-400 font-bold">{activeDevice.protocol}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-[10px] font-bold tracking-wider text-emerald-400 uppercase">Live Bus Capture</span>
                </div>
              </div>

              {/* Log Window */}
              <div className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-relaxed select-text space-y-2">
                {getDiagnosticLogs().map((log, idx) => (
                  <div key={idx} className="hover:bg-slate-800/60 p-2 rounded transition-colors border border-slate-800">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">[{log.time}]</span>
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                          log.dir === 'TX' ? 'bg-amber-950 text-amber-400' : 'bg-emerald-950 text-emerald-400'
                        }`}>
                          {log.dir === 'TX' ? '▲ TX (Request)' : '▼ RX (Response)'}
                        </span>
                        <span className="text-slate-400 text-xs font-sans">{log.desc}</span>
                      </div>
                    </div>
                    <div className="text-slate-300 break-all bg-slate-950/80 p-1.5 rounded text-[11px] text-cyan-300">
                      {log.hex}
                    </div>
                  </div>
                ))}

                {/* Protocol Packet Inspector */}
                <div className="mt-4 p-3.5 bg-slate-950 rounded-lg border border-slate-700">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                    <span>Protocol Frame Dissector</span>
                    <span className="text-indigo-400 font-mono">{activeMeta.standard}</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-slate-500 text-[10px] mb-0.5">Driver Interface</div>
                      <div className="text-white font-bold font-mono">{activeDevice.protocol}</div>
                    </div>
                    <div>
                      <div className="text-slate-500 text-[10px] mb-0.5">Physical Endpoint</div>
                      <div className="text-white font-bold font-mono">{activeDevice.ip}:{activeDevice.port}</div>
                    </div>
                    <div>
                      <div className="text-slate-500 text-[10px] mb-0.5">Active Points</div>
                      <div className="text-emerald-400 font-bold font-mono">{activeDevice.tags.length} Subscribed</div>
                    </div>
                    <div>
                      <div className="text-slate-500 text-[10px] mb-0.5">Buffer Integrity</div>
                      <div className="text-indigo-400 font-bold font-mono">100% (CRC/CRC32 Valid)</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* MODAL 1: Add New Protocol Device Node */}
      {isAddDeviceOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in zoom-in-95 max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-800 text-base">Add Industrial Driver Bridge</h3>
              </div>
              <button 
                onClick={() => setIsAddDeviceOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateDevice} className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Bridge Channel Name *</label>
                <input 
                  type="text" 
                  required
                  placeholder="e.g., PLC_Line2_Welder, Chiller_Plant_01"
                  value={newDeviceChannel}
                  onChange={(e) => setNewDeviceChannel(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">Select Industrial Driver Protocol *</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(Object.keys(PROTOCOL_CONFIGS) as Protocol[]).map(proto => {
                    const meta = PROTOCOL_CONFIGS[proto];
                    const isSelected = newDeviceProtocol === proto;
                    return (
                      <div
                        key={proto}
                        onClick={() => handleProtocolSelectInModal(proto)}
                        className={`p-3 rounded-lg border cursor-pointer transition-all ${
                          isSelected 
                            ? 'border-indigo-600 bg-indigo-50/80 shadow-sm' 
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-xs text-slate-800">{proto}</span>
                          <span className="text-[10px] font-mono font-semibold text-slate-500">:{meta.defaultPort}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 leading-tight">{meta.vendor}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">IP Address / Hostname *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="192.168.1.120"
                    value={newDeviceIp}
                    onChange={(e) => setNewDeviceIp(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Port</label>
                  <input 
                    type="text" 
                    required
                    value={newDevicePort}
                    onChange={(e) => setNewDevicePort(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              </div>

              {newDeviceProtocol === 'Siemens Profinet' && (
                <div className="grid grid-cols-2 gap-3 bg-cyan-50 p-3 rounded-lg border border-cyan-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Rack</label>
                    <input 
                      type="number" 
                      value={newDeviceRack}
                      onChange={(e) => setNewDeviceRack(parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-md text-sm bg-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Slot</label>
                    <input 
                      type="number" 
                      value={newDeviceSlot}
                      onChange={(e) => setNewDeviceSlot(parseInt(e.target.value) || 1)}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-md text-sm bg-white font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3 shrink-0">
                <button 
                  type="button"
                  onClick={() => setIsAddDeviceOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors"
                >
                  Create Device Bridge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Add or Edit Tag Mapping */}
      {isTagModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in zoom-in-95">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <List className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-800 text-base">
                  {editingTag ? 'Edit Point Mapping' : `Add Point to ${activeDevice.channel}`}
                </h3>
              </div>
              <button 
                onClick={() => setIsTagModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveTag} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Variable Name (Tag ID) *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="e.g., R0021.MotorSpeed"
                    value={tagForm.variableName}
                    onChange={(e) => setTagForm(prev => ({ ...prev, variableName: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Address / NodeID *
                  </label>
                  <input 
                    type="text" 
                    required
                    placeholder={activeMeta.sampleAddress}
                    value={tagForm.address}
                    onChange={(e) => setTagForm(prev => ({ ...prev, address: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono text-indigo-600 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 truncate">
                    Syntax: {activeMeta.addressSyntaxHelp}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Data Type</label>
                  <select 
                    value={tagForm.dataType}
                    onChange={(e) => setTagForm(prev => ({ ...prev, dataType: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="Float">Float (32-bit IEEE 754)</option>
                    <option value="Double">Double (64-bit)</option>
                    <option value="Int16">Int16 (Signed Word / Short)</option>
                    <option value="Int32">Int32 (Signed DWord / Integer)</option>
                    <option value="Uint16">Uint16 (Unsigned Word)</option>
                    <option value="Uint32">Uint32 (Unsigned DWord)</option>
                    <option value="Bool">Bool (Discrete Bit)</option>
                    <option value="String">String (ASCII / UTF-8)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Engineering Unit</label>
                  <input 
                    type="text" 
                    placeholder="e.g., °C, bar, RPM, kW, %"
                    value={tagForm.unit}
                    onChange={(e) => setTagForm(prev => ({ ...prev, unit: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div className="text-[11px] font-bold text-slate-600 mb-2 flex items-center justify-between">
                  <span>Linear Calibration Formula (y = Scale × x + Offset)</span>
                  <span className="text-slate-400 font-normal">Optional</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">Scale Multiplier</label>
                    <input 
                      type="number" 
                      step="any"
                      value={tagForm.scale ?? 1}
                      onChange={(e) => setTagForm(prev => ({ ...prev, scale: parseFloat(e.target.value) || 1 }))}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-md text-sm bg-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500 mb-1">Offset Addition</label>
                    <input 
                      type="number" 
                      step="any"
                      value={tagForm.offset ?? 0}
                      onChange={(e) => setTagForm(prev => ({ ...prev, offset: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-md text-sm bg-white font-mono"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Description / Tag Notes</label>
                <input 
                  type="text" 
                  placeholder="e.g., Boiler feed water temperature sensor transmitter"
                  value={tagForm.description}
                  onChange={(e) => setTagForm(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button 
                  type="button"
                  onClick={() => setIsTagModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors"
                >
                  {editingTag ? 'Save Changes' : 'Create Point'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
