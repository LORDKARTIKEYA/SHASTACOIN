import { EventEmitter } from 'events';
import { BaseAddress, IndexedAddress, Address } from './address';
import { ReducedTransaction, TransactionData } from './transaction';
import { walletUtils } from './utils/walletUtils';
import { SignatureData } from './signature';
import * as cryptoUtils from './utils/cryptoUtils';
import { BigDecimal, Network } from './utils/utils';
import BN from 'bn.js';

type KeyPair = cryptoUtils.KeyPair;

export interface WalletEvent {
  on(event: 'balanceChange', listener: (address: BaseAddress) => void): this;
  on(event: 'generateAddress', listener: (addressHex: string) => void): this;
  on(event: 'receivedTransaction', listener: (transaction: TransactionData) => void): this;

  emit(event: 'balanceChange', address: BaseAddress): boolean;
  emit(event: 'generateAddress', addressHex: string): boolean;
  emit(event: 'receivedTransaction', transaction: TransactionData): boolean;
}

export abstract class WalletEvent extends EventEmitter {
  public onBalanceChange(listener: (address: BaseAddress) => void): this {
    return this.on('balanceChange', listener);
  }

  public onGenerateAddress(listener: (addressHex: string) => void): this {
    return this.on('generateAddress', listener);
  }

  public onReceivedTransaction(listener: (transaction: TransactionData) => void): this {
    return this.on('receivedTransaction', listener);
  }
}

export class BaseWallet extends WalletEvent {
  protected readonly network: Network;
  protected readonly addressMap: Map<string, BaseAddress>;
  protected readonly transactionMap: Map<string, ReducedTransaction>;

  constructor(network?: Network) {
    super();
    this.network = network || 'mainnet';
    this.addressMap = new Map();
    this.transactionMap = new Map();
  }

  public async loadAddresses(addresses: BaseAddress[]) {
    if (!addresses || !addresses.length) return;
    addresses.forEach(address => {
      this.setInitialAddressToMap(address);
    });
  }

  public getNetwork() {
    return this.network;
  }

  public isAddressExists(addressHex: string) {
    return this.addressMap.has(addressHex);
  }

  public getAddressMap() {
    return this.addressMap;
  }

  public getAddressHexes() {
    return [...this.addressMap.keys()];
  }

  protected setInitialAddressToMap(address: BaseAddress) {
    this.setAddressToMap(address);
  }

  protected setAddressToMap(address: BaseAddress) {
    this.addressMap.set(address.getAddressHex(), address);
  }

  public getAddressByAddressHex(addressHex: string) {
    return this.addressMap.get(addressHex);
  }

  public async checkBalancesOfAddresses(addresses: BaseAddress[]) {
    const addressesBalance = await walletUtils.checkBalances(
      addresses.map(address => address.getAddressHex()),
      this
    );
    for (const address of addresses) {
      let { addressBalance, addressPreBalance } = addressesBalance[address.getAddressHex()];
      const balance = new BigDecimal(`${addressBalance}`);
      const preBalance = new BigDecimal(`${addressPreBalance}`);
      const existingAddress = this.addressMap.get(address.getAddressHex());
      if (
        !existingAddress ||
        existingAddress.getBalance().comparedTo(balance) !== 0 ||
        existingAddress.getPreBalance().comparedTo(preBalance) !== 0
      ) {
        this.setAddressWithBalance(address, balance, preBalance);
      }
    }
  }

  public setAddressWithBalance(address: BaseAddress, balance: BigDecimal, preBalance: BigDecimal) {
    address.setBalance(balance);
    address.setPreBalance(preBalance);
    this.setAddressToMap(address);

    this.emit('balanceChange', address);
  }

  public getTotalBalance() {
    let balance = new BigDecimal('0');
    let prebalance = new BigDecimal('0');
    this.addressMap.forEach(address => {
      balance = balance.add(address.getBalance());
      prebalance = prebalance.add(address.getPreBalance());
    });

    return { balance, prebalance };
  }

  public async loadTransactionHistory(transactions: ReducedTransaction[]) {
    if (!transactions || !transactions.length) return;
    transactions.forEach(tx => {
      this.transactionMap.set(tx.hash, tx);
    });
  }

  public getTransactionByHash(hash: string) {
    return this.transactionMap.get(hash);
  }

  public async getTransactionHistory() {
    console.log('Starting to get transaction history');
    const addresses = this.getAddressHexes();
    const transactions = await walletUtils.getTransactionsHistory(addresses, this);
    transactions.forEach(t => {
      this.setTransaction(t);
    });
    console.log(`Finished to get transaction history. Total transactions: ${transactions.size}`);
  }

  public setTransaction(transaction: TransactionData) {
    const existingTransaction = this.transactionMap.get(transaction.hash);

    // If the transaction was already confirmed, no need to reprocess it
    if (existingTransaction && existingTransaction.transactionConsensusUpdateTime === transaction.transactionConsensusUpdateTime) return;

    this.transactionMap.set(
      transaction.hash,
      new ReducedTransaction(transaction.hash, transaction.createTime, transaction.transactionConsensusUpdateTime)
    );

    this.emit('receivedTransaction', transaction);
  }
}

type Constructor<T> = { new (...args: any[]): T };

export abstract class IndexedWallet<T extends IndexedAddress> extends BaseWallet {
  protected readonly indexToAddressHexMap: Map<number, string>;
  protected publicHash!: string;
  protected trustScore!: number;

  constructor(network?: Network) {
    super(network);
    this.indexToAddressHexMap = new Map();
  }

  async init() {
    await this.setPublicHash();
  }

  public abstract async setPublicHash(): Promise<void>;

  private checkAddressIndexed(address: BaseAddress) {
    if (!(address instanceof IndexedAddress)) throw new Error('Address should be indexed');
  }

  protected addressTypeGuard(address: BaseAddress, Class: Constructor<T>) {
    if (!(address instanceof Class)) throw new Error('Wrong address type');
  }

  public abstract checkAddressType(address: BaseAddress): void;

  protected setAddressToMap(address: BaseAddress) {
    this.checkAddressType(address);
    super.setAddressToMap(address);
    const index = (<T>address).getIndex();
    this.indexToAddressHexMap.set(index, address.getAddressHex());
  }

  protected setInitialAddressToMap(address: BaseAddress) {
    this.checkAddressIndexed(address);
    const typedAddress = this.getAddressFromIndexedAddress(<IndexedAddress>address);
    super.setInitialAddressToMap(typedAddress);
    this.indexToAddressHexMap.set(typedAddress.getIndex(), typedAddress.getAddressHex());
  }

  public abstract getAddressFromIndexedAddress(indexedAddress: IndexedAddress): T;

  public getIndexByAddress(addressHex: string) {
    const address = this.addressMap.get(addressHex);
    return address ? (<T>address).getIndex() : null;
  }

  public async getAddressByIndex(index: number) {
    const addressHex = this.indexToAddressHexMap.get(index);
    if (!addressHex) return await this.generateAndSetAddressByIndex(index);
    const address = this.addressMap.get(addressHex);
    return address ? <T>address : await this.generateAndSetAddressByIndex(index);
  }

  public async generateAndSetAddressByIndex(index: number) {
    const address = await this.generateAddressByIndex(index);
    this.setAddressToMap(address);
    return address;
  }

  public getPublicHash() {
    return this.publicHash;
  }

  public abstract async signMessage(messageInBytes: Uint8Array, addressHex?: string): Promise<SignatureData>;

  public async autoDiscoverAddresses() {
    console.log(`Starting to discover addresses`);
    const addresses = await walletUtils.getAddressesOfWallet(this);
    addresses.length > 0 ? await this.checkBalancesOfAddresses(addresses) : console.log('No addresses');
    console.log(`Finished to discover addresses. Total addresses: ${addresses.length}`);
    return this.getAddressMap();
  }

  public abstract async generateAddressByIndex(index: number): Promise<T>;

  public async getUserTrustScore() {
    let { data } = await walletUtils.getUserTrustScore(this);
    if (!data) throw new Error(`Error getting user trust score, received no data`);
    if (!data.trustScore) throw new Error('Error getting user trust score, unexpected response:' + data);
    this.trustScore = data.trustScore;
    return this.trustScore;
  }
}

export class Wallet extends IndexedWallet<Address> {
  private seed!: string;
  private keyPair!: KeyPair;

  constructor(params: { seed?: string; userSecret?: string; serverKey?: BN; network?: Network }) {
    const { seed, userSecret, serverKey, network } = params;
    super(network);
    if (seed) {
      if (!this.checkSeedFormat(seed)) throw new Error('Seed is not in correct format');
      this.seed = seed;
    } else if (userSecret && serverKey) this.generateSeed(userSecret, serverKey);
    // should call to server before to get a serverkey ...
    else throw new Error('Invalid parameters for Wallet');

    this.generateAndSetKeyPair();
    this.setPublicHash();
  }

  private checkSeedFormat(seed: string) {
    return seed.length === 64;
  }

  private generateSeed(userSecret: string, serverKey: BN) {
    let hexServerKey = serverKey.toString(16, 2);
    let combinedString = `${userSecret}${hexServerKey}`;
    this.seed = cryptoUtils.generateSeed(combinedString);
  }

  private generateAndSetKeyPair() {
    this.keyPair = cryptoUtils.generateKeyPairFromSeed(this.seed);
  }

  public async setPublicHash() {
    this.publicHash = cryptoUtils.getPublicKeyByKeyPair(this.keyPair);
  }

  private generateKeyPairByIndex(index: number) {
    return cryptoUtils.generateKeyPairFromSeed(this.seed, index);
  }

  private getKeyPair() {
    return this.keyPair;
  }

  public async generateAddressByIndex(index: number) {
    const keyPair = this.generateKeyPairByIndex(index);
    return new Address(keyPair, index);
  }

  public getAddressFromIndexedAddress(indexedAddress: IndexedAddress) {
    const keyPair = this.generateKeyPairByIndex(indexedAddress.getIndex());
    const address = new Address(keyPair, indexedAddress.getIndex());
    address.setBalance(indexedAddress.getBalance());
    address.setPreBalance(indexedAddress.getPreBalance());
    return address;
  }

  public checkAddressType(address: BaseAddress) {
    this.addressTypeGuard(address, Address);
  }

  public async signMessage(messageInBytes: Uint8Array, addressHex?: string) {
    let keyPair;
    if (addressHex) {
      const address = this.getAddressByAddressHex(addressHex);
      if (!address) throw new Error(`Wallet doesn't contain the address`);
      keyPair = (<Address>address).getAddressKeyPair();
    } else keyPair = this.getKeyPair();
    return cryptoUtils.signByteArrayMessage(messageInBytes, keyPair);
  }
}
