import { describe, expect, it } from 'vitest'
import { adaptersFromRegistry, chooseProfile, parseNvidiaSmi, parseRegValues, vendorFromPci } from './gpu'

const K = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

const reg = (name: string, rows: [string, string, string][]): string =>
  [`${K}`, ...rows.flatMap(([sub, type, val]) => [`${K}\\${sub}`, `    ${name}    ${type}    ${val}`, ''])].join('\r\n')

describe('registry parsing', () => {
  const desc = reg('DriverDesc', [
    ['0000', 'REG_SZ', 'NVIDIA GeForce RTX 3080'],
    ['0001', 'REG_SZ', 'Microsoft Remote Display Adapter'],
    ['0002', 'REG_SZ', 'AMD Radeon(TM) Graphics']
  ])
  const ids = reg('MatchingDeviceId', [
    ['0000', 'REG_SZ', 'PCI\\VEN_10DE&DEV_2206&SUBSYS_38971462'],
    ['0001', 'REG_SZ', 'SWD\\RemoteDisplayEnum'],
    ['0002', 'REG_SZ', 'PCI\\VEN_1002&DEV_164C']
  ])
  const mem = reg('HardwareInformation.qwMemorySize', [['0000', 'REG_QWORD', '0x280000000']])
  const mem32 = reg('HardwareInformation.MemorySize', [['0002', 'REG_BINARY', '0x20000000']])

  it('reads values per adapter', () => {
    expect(parseRegValues(desc, 'DriverDesc').size).toBe(3)
  })

  it('lists physical adapters with vendor and memory', () => {
    expect(adaptersFromRegistry(desc, ids, mem, mem32)).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080', vramMb: 10240 },
      { vendor: 'amd', name: 'AMD Radeon(TM) Graphics', vramMb: 512 }
    ])
  })

  it('maps PCI vendors', () => {
    expect(vendorFromPci('PCI\\VEN_10DE&DEV_1')).toBe('nvidia')
    expect(vendorFromPci('PCI\\VEN_1002&DEV_1')).toBe('amd')
    expect(vendorFromPci('PCI\\VEN_8086&DEV_1')).toBe('intel')
    expect(vendorFromPci('junk')).toBe('other')
  })
})

describe('parseNvidiaSmi', () => {
  it('reads name, memory and driver', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080, 10240, 581.57\r\n')).toEqual([{ name: 'NVIDIA GeForce RTX 3080', vramMb: 10240, driver: '581.57' }])
    expect(parseNvidiaSmi('')).toEqual([])
  })
})

describe('chooseProfile', () => {
  it('uses CUDA and Vulkan on a good NVIDIA card', () => {
    const p = chooseProfile([{ vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }], 581.57, 16384, 16)
    expect(p).toMatchObject({ whisper: 'cuda', llm: 'vulkan' })
  })
  it('falls back to CPU whisper on old NVIDIA drivers', () => {
    expect(chooseProfile([{ vendor: 'nvidia', name: 'x', vramMb: 10240 }], 391.0, 16384, 16).whisper).toBe('cpu')
  })
  it('uses Vulkan for whisper and the LLM on AMD', () => {
    const p = chooseProfile([{ vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 }], null, 32768, 16)
    expect(p).toMatchObject({ whisper: 'vulkan', llm: 'vulkan' })
    expect(p.primary?.name).toBe('RX 9060 XT')
  })
  it('keeps whisper on the CPU on an AMD card with too little memory', () => {
    const p = chooseProfile([{ vendor: 'amd', name: 'Radeon Graphics', vramMb: 512 }], null, 16384, 16)
    expect(p).toMatchObject({ whisper: 'cpu', llm: 'cpu' })
    expect(chooseProfile([{ vendor: 'amd', name: 'RX 6400', vramMb: 3000 }], null, 16384, 16).whisper).toBe('cpu')
  })
  it('does not use Vulkan for whisper on integrated Intel graphics or an unknown memory size', () => {
    expect(chooseProfile([{ vendor: 'intel', name: 'Arc', vramMb: 8192 }], null, 16384, 16).whisper).toBe('cpu')
    expect(chooseProfile([{ vendor: 'amd', name: 'RX', vramMb: null }], null, 16384, 16).whisper).toBe('cpu')
  })
  it('prefers CUDA over Vulkan when both an NVIDIA and an AMD card are present', () => {
    const p = chooseProfile(
      [
        { vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 },
        { vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }
      ],
      581.0,
      16384,
      16
    )
    expect(p.whisper).toBe('cuda')
  })
  it('prefers the dedicated card over integrated graphics', () => {
    const p = chooseProfile(
      [
        { vendor: 'intel', name: 'UHD 770', vramMb: 128 },
        { vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }
      ],
      581.0,
      16384,
      16
    )
    expect(p.primary?.vendor).toBe('nvidia')
  })
  it('runs everything on the CPU without a usable GPU', () => {
    expect(chooseProfile([], null, 8192, 8)).toMatchObject({ whisper: 'cpu', llm: 'cpu', primary: null })
    expect(chooseProfile([{ vendor: 'intel', name: 'UHD', vramMb: 128 }], null, 8192, 8).llm).toBe('cpu')
  })
})
