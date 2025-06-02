import React from 'react'
import { useReadContract } from "thirdweb/react";
import { useActiveAccount } from "thirdweb/react";
import { useSendTransaction } from "thirdweb/react";
import { prepareContractCall } from "thirdweb";
import { useState } from "react";

import {gameContractGovernorTreasury } from "@/utils/functionDump/getContracts"

import { Button, Input } from "@material-tailwind/react";














const BoDDaoTreasuryComponent = () => {





//Governor Treasury //Governor Treasury //Governor Treasury
//Governor Treasury //Governor Treasury //Governor Treasury
//Governor Treasury //Governor Treasury //Governor Treasury


    const { data: showGovernorTreasuryArray, isLoading: GovernorTreasuryLoad } = useReadContract({
      contract: gameContractGovernorTreasury,
      method: "function showTreasuryArray() returns(string[] memory)",
    });
  
  

  

  




      const [token, setToken] = useState("");

      const { data: showAmount, isLoading: showAmountLoad } = useReadContract({
        contract: gameContractGovernorTreasury,
        method: "function showTokenAmount(string memory _name) returns (uint256)",
        params: [token ? token : null],
      });
      const { data: showTokenAddress, isLoading: showTokenAddressLoad } = useReadContract({
        contract: gameContractGovernorTreasury,
        method: "function showTokenAddress(string memory _name) returns (address)",
        params: [token ? token : null],
      });
      const { data: showTokenId, isLoading: showTokenIdLoad } = useReadContract({
        contract: gameContractGovernorTreasury,
        method: "function showTokenId(string memory _name) returns (uint256)",
        params: [token ? token : null],
      });
      const { data: showTokenIsERC20, isLoading: showTokenIsERC20Load } = useReadContract({
        contract: gameContractGovernorTreasury,
        method: "function showTokenIsERC20(string memory _name) returns (bool)",
        params: [token ? token : null],
      });
  
  





        const [updateToken, setUpdateToken] = useState("");
        const { mutate: updateFundCheck, data: updateFundCheckDAta } = useSendTransaction();
    
        const updateFundCheckTx = () => {
          const updateFundCheckTrans = prepareContractCall({
              contract: gameContractGovernorTreasury,
              method: "function updateFundCheck(string memory _tokenName)",
              params: [updateToken ? updateToken : null],
            })
            updateFundCheck(updateFundCheckTrans);
          };



  



  return (
    <div>
      <h3 className='my-3 font-bold text-lg'>
        DAO Treasury
      </h3>
      <ul>
        <li>
          DAO Treasury Address: {gameContractGovernorTreasury.address}
        </li>
        <li>
          Accepted Tokens, DAO Treasury: {showGovernorTreasuryArray ? showGovernorTreasuryArray.join(', ') : null}
        </li>
        <li className='flex flex-row items-center gap-3'>
          <Input
              type="text"
              color="white"
              label="input de token name"
              className=" !border-t-blue-gray-200 focus:!border-t-gray-900"
              onChange={(e) => {setToken(e.target.value)}}
            />
        </li>
        <li>
          Token Name: {token}
        </li>
        <li>
          Token Amount: {Number(showAmount)}
        </li>
        <li>
          Token Addres: {showTokenAddress}
        </li>
        <li>
          Token Id: {Number(showTokenId)}
        </li>
        <li>
          Token IsERC20: {showTokenIsERC20 ? "Yes, its ERC-20" : "not ERC-20"}
        </li>
      </ul>
      <h3 className='my-3 font-bold text-lg'>
        Update Treasury
      </h3>
      <ul>
        <li>
        Update Treasury Token Funds:
        <div className='w-52'>
            <Input
              type="text"
              size="lg"
              label="Update dis token"
              color="white"
              className=" !border-t-blue-gray-200 focus:!border-t-gray-900"
              onChange={(e) => {setUpdateToken(e.target.value)}}
            />
          </div>
          <Button onClick={() => updateFundCheckTx()}>
            Update
          </Button>
        </li>
      </ul>
    </div>
  )
}


export default BoDDaoTreasuryComponent