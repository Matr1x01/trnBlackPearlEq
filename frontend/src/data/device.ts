/**
 * Static device identity.
 *
 * The HID protocol only exposes the firmware version (CmdVersion) -- model,
 * brand and manufacturer are not readable from the device, so they are
 * hard-coded here to match what the vendor's own control panel reports for
 * the TRN Black Pearl / TE-C. Firmware comes from the live `/api/status`
 * response and is rendered separately.
 */
export const DEVICE_INFO = {
  model: "Black Pearl",
  name: "Black Pearl",
  brand: "TRN",
  manufacturer: "Dongguan Zuo Du Acoustic Technology Co., Ltd.",
  interface: "USB-C · USB Audio Class 2.0",
  vendorId: "0x3302",
  productId: "0x43E8",
} as const;
